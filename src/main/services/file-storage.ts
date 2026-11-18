import { app } from "electron";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoragePayload, StorageStats } from "@shared/ipc";
import { log } from "./logger";

const STORE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_MAX_LENGTH = 512;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

type StoredKind = StoragePayload["kind"];

type StoredMeta = {
    key: string;
    kind: StoredKind;
    mimeType?: string;
    updatedAt: string;
};

function storageRoot() {
    return join(app.getPath("userData"), "storage");
}

function assertStore(store: string) {
    if (!STORE_PATTERN.test(store)) throw new Error(`Invalid storage store: ${store}`);
    return store;
}

function assertKey(key: string) {
    if (!key || key.length > KEY_MAX_LENGTH) throw new Error("Invalid storage key");
}

function keyHash(key: string) {
    return createHash("sha256").update(key).digest("hex");
}

function storeDir(store: string) {
    return join(storageRoot(), assertStore(store));
}

function dataPath(dir: string, hash: string, kind: StoredKind) {
    const extension = kind === "binary" ? "bin" : kind === "json" ? "json" : "txt";
    return join(dir, `${hash}.${extension}`);
}

function metaPath(dir: string, hash: string) {
    return join(dir, `${hash}.meta.json`);
}

async function atomicWrite(path: string, data: string | Uint8Array) {
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, data);
    await rename(temporary, path);
}

async function readMeta(dir: string, hash: string): Promise<StoredMeta | null> {
    try {
        return JSON.parse(await readFile(metaPath(dir, hash), "utf8")) as StoredMeta;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        log.warn("Failed to read storage metadata", error);
        return null;
    }
}

function toBuffer(value: unknown) {
    if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("Invalid binary payload");
}

export const fileStorage = {
    async get(store: string, key: string): Promise<StoragePayload | null> {
        assertKey(key);
        const dir = storeDir(store);
        const hash = keyHash(key);
        const meta = await readMeta(dir, hash);
        if (!meta) return null;
        try {
            if (meta.kind === "binary") {
                const file = await readFile(dataPath(dir, hash, meta.kind));
                const data = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
                return { kind: "binary", mimeType: meta.mimeType || "application/octet-stream", data };
            }
            const text = await readFile(dataPath(dir, hash, meta.kind), "utf8");
            if (meta.kind === "json") return { kind: "json", value: JSON.parse(text) };
            return { kind: "string", value: text };
        } catch (error) {
            log.warn("Failed to read storage value", { store, key, error });
            return null;
        }
    },

    async set(store: string, key: string, payload: StoragePayload): Promise<void> {
        assertKey(key);
        const dir = storeDir(store);
        const hash = keyHash(key);
        await mkdir(dir, { recursive: true });

        const previous = await readMeta(dir, hash);
        const meta: StoredMeta = {
            key,
            kind: payload.kind,
            mimeType: payload.kind === "binary" ? payload.mimeType : undefined,
            updatedAt: new Date().toISOString(),
        };

        if (payload.kind === "binary") {
            const buffer = toBuffer(payload.data);
            if (buffer.byteLength > MAX_BINARY_BYTES) throw new Error("Storage value exceeds size limit");
            await atomicWrite(dataPath(dir, hash, payload.kind), buffer);
        } else if (payload.kind === "json") {
            await atomicWrite(dataPath(dir, hash, payload.kind), JSON.stringify(payload.value ?? null));
        } else {
            await atomicWrite(dataPath(dir, hash, payload.kind), payload.value);
        }

        if (previous && previous.kind !== payload.kind) {
            await rm(dataPath(dir, hash, previous.kind), { force: true });
        }
        await atomicWrite(metaPath(dir, hash), JSON.stringify(meta));
    },

    async remove(store: string, key: string): Promise<void> {
        assertKey(key);
        const dir = storeDir(store);
        const hash = keyHash(key);
        const meta = await readMeta(dir, hash);
        await Promise.all([rm(metaPath(dir, hash), { force: true }), ...(meta ? [rm(dataPath(dir, hash, meta.kind), { force: true })] : ["txt", "json", "bin"].map((extension) => rm(join(dir, `${hash}.${extension}`), { force: true })))]);
    },

    async keys(store: string): Promise<string[]> {
        const dir = storeDir(store);
        let files: string[];
        try {
            files = await readdir(dir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        const result: string[] = [];
        await Promise.all(
            files
                .filter((file) => file.endsWith(".meta.json"))
                .map(async (file) => {
                    try {
                        const meta = JSON.parse(await readFile(join(dir, file), "utf8")) as StoredMeta;
                        if (typeof meta.key === "string") result.push(meta.key);
                    } catch (error) {
                        log.warn("Skipped unreadable storage metadata", { store, file, error });
                    }
                }),
        );
        return result.sort();
    },

    async clear(store: string): Promise<void> {
        const dir = storeDir(store);
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
    },

    async stats(): Promise<StorageStats> {
        let entries: Dirent<string>[] = [];
        try {
            entries = await readdir(storageRoot(), { withFileTypes: true, encoding: "utf8" });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const stores: StorageStats["stores"] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = join(storageRoot(), entry.name);
            let files: string[] = [];
            try {
                files = await readdir(dir);
            } catch {
                continue;
            }
            let bytes = 0;
            let records = 0;
            for (const file of files) {
                if (file.endsWith(".meta.json")) {
                    records += 1;
                    continue;
                }
                try {
                    bytes += (await stat(join(dir, file))).size;
                } catch {
                    // Ignore files that disappear during the scan.
                }
            }
            stores.push({ name: entry.name, records, bytes });
        }
        stores.sort((left, right) => right.bytes - left.bytes);
        return { totalBytes: stores.reduce((total, store) => total + store.bytes, 0), stores };
    },
};
