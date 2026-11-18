import { app, safeStorage } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "./logger";

const VAULT_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

type VaultEntry = {
    value: string;
    encrypted: boolean;
};

type VaultFile = {
    version: number;
    entries: Record<string, VaultEntry>;
};

let cache: VaultFile | null = null;

function vaultPath() {
    return join(app.getPath("userData"), "config", "secrets.json");
}

function assertId(id: string) {
    if (!ID_PATTERN.test(id)) throw new Error("Invalid secret id");
}

async function loadVault(): Promise<VaultFile> {
    if (cache) return cache;
    try {
        const parsed = JSON.parse(await readFile(vaultPath(), "utf8")) as VaultFile;
        if (parsed && parsed.version === VAULT_VERSION && parsed.entries && typeof parsed.entries === "object") {
            cache = parsed;
        } else {
            log.warn("Secret vault has an unsupported format; starting empty");
            cache = { version: VAULT_VERSION, entries: {} };
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Failed to read secret vault", error);
        cache = { version: VAULT_VERSION, entries: {} };
    }
    return cache;
}

async function saveVault(vault: VaultFile) {
    const path = vaultPath();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(vault, null, 2), "utf8");
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    cache = vault;
}

function decodeEntry(entry: VaultEntry): string | null {
    try {
        const buffer = Buffer.from(entry.value, "base64");
        if (!entry.encrypted) return buffer.toString("utf8");
        if (!safeStorage.isEncryptionAvailable()) {
            log.warn("A secret is encrypted but OS encryption is unavailable");
            return null;
        }
        return safeStorage.decryptString(buffer);
    } catch (error) {
        log.warn("Failed to decrypt a secret", error);
        return null;
    }
}

export const secretVault = {
    async get(id: string): Promise<string | null> {
        assertId(id);
        const vault = await loadVault();
        const entry = vault.entries[id];
        return entry ? decodeEntry(entry) : null;
    },

    async set(id: string, value: string): Promise<void> {
        assertId(id);
        const vault = await loadVault();
        if (!value) {
            delete vault.entries[id];
            await saveVault(vault);
            return;
        }
        const encrypted = safeStorage.isEncryptionAvailable();
        const buffer = encrypted ? safeStorage.encryptString(value) : Buffer.from(value, "utf8");
        vault.entries[id] = { value: buffer.toString("base64"), encrypted };
        await saveVault(vault);
    },

    async remove(id: string): Promise<void> {
        assertId(id);
        const vault = await loadVault();
        if (!vault.entries[id]) return;
        delete vault.entries[id];
        await saveVault(vault);
    },

    async list(): Promise<Record<string, string>> {
        const vault = await loadVault();
        const result: Record<string, string> = {};
        for (const [id, entry] of Object.entries(vault.entries)) {
            const value = decodeEntry(entry);
            if (value !== null) result[id] = value;
        }
        return result;
    },
};
