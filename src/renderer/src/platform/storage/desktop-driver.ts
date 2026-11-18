import localforage from "localforage";

import type { StoragePayload } from "@shared/ipc";
import { getDesktopBridge } from "../bridge";

export const DESKTOP_STORAGE_DRIVER = "unleashlyFileStorage";

type DriverOptions = { name?: string; storeName?: string };

type DesktopDriverInfo = {
    name: string;
    storeName: string;
    storeId: string;
};

type DriverInstance = {
    _dbInfo?: DesktopDriverInfo;
};

function storeIdFor(name: string, storeName: string) {
    return `${name}__${storeName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function driverInfo(instance: DriverInstance): DesktopDriverInfo {
    if (!instance._dbInfo) throw new Error("Desktop storage driver is not initialized");
    return instance._dbInfo;
}

function promiseOrCallback<T>(promise: Promise<T>, callback?: (error: unknown, value?: T) => void) {
    if (typeof callback === "function") {
        promise.then(
            (value) => callback(null, value),
            (error) => callback(error),
        );
        return;
    }
    return promise;
}

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
    if (value instanceof ArrayBuffer) return value;
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function decodeValue(payload: StoragePayload | null) {
    if (!payload) return null;
    if (payload.kind === "string") return payload.value;
    if (payload.kind === "json") return payload.value;
    return new Blob([toArrayBuffer(payload.data)], { type: payload.mimeType });
}

async function encodeValue(value: unknown): Promise<StoragePayload> {
    if (value instanceof Blob) {
        return { kind: "binary", mimeType: value.type || "application/octet-stream", data: await value.arrayBuffer() };
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return { kind: "binary", mimeType: "application/octet-stream", data: toArrayBuffer(value) };
    }
    if (typeof value === "string") {
        return { kind: "string", value };
    }
    return { kind: "json", value };
}

export function defineDesktopStorageDriver() {
    const bridge = getDesktopBridge();
    if (!bridge) return false;

    const driver = {
        _driver: DESKTOP_STORAGE_DRIVER,
        _support: true,
        _initStorage(this: DriverInstance, options: DriverOptions) {
            const name = options.name || "unleashly";
            const storeName = options.storeName || "keyvaluepairs";
            this._dbInfo = { name, storeName, storeId: storeIdFor(name, storeName) };
        },
        getItem(this: DriverInstance, key: string, callback?: (error: unknown, value?: unknown) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(bridge.storage.get(info.storeId, key).then(decodeValue), callback);
        },
        setItem(this: DriverInstance, key: string, value: unknown, callback?: (error?: unknown) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(
                (async () => {
                    await bridge.storage.set(info.storeId, key, await encodeValue(value));
                })(),
                callback,
            );
        },
        removeItem(this: DriverInstance, key: string, callback?: (error?: unknown) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(bridge.storage.remove(info.storeId, key), callback);
        },
        clear(this: DriverInstance, callback?: (error?: unknown) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(bridge.storage.clear(info.storeId), callback);
        },
        length(this: DriverInstance, callback?: (error: unknown, length?: number) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(
                bridge.storage.keys(info.storeId).then((keys) => keys.length),
                callback,
            );
        },
        key(this: DriverInstance, index: number, callback?: (error: unknown, key?: string | null) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(
                bridge.storage.keys(info.storeId).then((keys) => keys[index] ?? null),
                callback,
            );
        },
        keys(this: DriverInstance, callback?: (error: unknown, keys?: string[]) => void) {
            const info = driverInfo(this);
            return promiseOrCallback(bridge.storage.keys(info.storeId), callback);
        },
        iterate(this: DriverInstance, iteratorCallback: (value: unknown, key: string, iterationNumber: number) => unknown, successCallback?: (result?: unknown) => void) {
            const info = driverInfo(this);
            const run = async () => {
                const keys = await bridge.storage.keys(info.storeId);
                for (let index = 0; index < keys.length; index += 1) {
                    const key = keys[index];
                    const value = decodeValue(await bridge.storage.get(info.storeId, key));
                    const result = iteratorCallback(value, key, index + 1);
                    if (result !== undefined) return result;
                }
                return undefined;
            };
            return promiseOrCallback(run(), (error, result) => {
                if (error) successCallback?.(error);
                else successCallback?.(result);
            });
        },
        dropInstance(this: DriverInstance, options: DriverOptions | ((error?: unknown) => void), callback?: (error?: unknown) => void) {
            const cb = typeof options === "function" ? options : callback;
            const info = driverInfo(this);
            return promiseOrCallback(bridge.storage.clear(info.storeId), cb);
        },
    };

    localforage.defineDriver(driver as unknown as Parameters<typeof localforage.defineDriver>[0]);
    return true;
}
