import localforage from "localforage";

import { getDesktopBridge } from "../bridge";
import { DESKTOP_STORAGE_DRIVER } from "./desktop-driver";

const LEGACY_DB_NAME = "infinite-canvas";
const LEGACY_STORES = ["app_state", "image_files", "image_previews", "media_files", "image_generation_logs", "video_generation_logs"];
const MIGRATION_STORE = "unleashly";
const MIGRATION_KEY = "storage:migrated:v1";
const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

async function sanitizeConfigStoreValue(value: unknown) {
    if (typeof value !== "string") return value;
    let parsed: {
        state?: {
            config?: { apiKey?: string; channels?: Array<{ id?: string; apiKey?: string }> };
            webdav?: { password?: string };
        };
    };
    try {
        parsed = JSON.parse(value);
    } catch {
        return value;
    }
    const bridge = getDesktopBridge();
    if (!bridge) return value;
    const config = parsed.state?.config;
    if (config?.channels) {
        for (const channel of config.channels) {
            if (!channel.id || !channel.apiKey) continue;
            try {
                await bridge.secrets.set(channel.id, channel.apiKey);
                channel.apiKey = "";
            } catch {
                // Keep the key in the migrated value rather than silently losing it.
            }
        }
    }
    if (config && typeof config.apiKey === "string" && config.apiKey) config.apiKey = "";
    const webdav = parsed.state?.webdav;
    if (webdav?.password) {
        try {
            await bridge.secrets.set("__webdav__", webdav.password);
            webdav.password = "";
        } catch {
            // Keep the password in the migrated value rather than silently losing it.
        }
    }
    return JSON.stringify(parsed);
}

export async function migrateLegacyStorage(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;

    const existing = await bridge.storage.get(MIGRATION_STORE, MIGRATION_KEY);
    if (existing?.kind === "json" && (existing.value as { completed?: boolean } | null)?.completed) return true;

    for (const storeName of LEGACY_STORES) {
        const legacy = localforage.createInstance({ name: LEGACY_DB_NAME, storeName, driver: localforage.INDEXEDDB });
        const target = localforage.createInstance({ name: LEGACY_DB_NAME, storeName, driver: DESKTOP_STORAGE_DRIVER });

        let keys: string[] = [];
        try {
            keys = await legacy.keys();
        } catch {
            // A missing legacy database simply has no keys to migrate.
            continue;
        }

        for (const key of keys) {
            if ((await target.getItem(key)) !== null) continue;
            const value = await legacy.getItem(key);
            if (value === null) continue;
            await target.setItem(key, storeName === "app_state" && key === CONFIG_STORE_KEY ? await sanitizeConfigStoreValue(value) : value);
        }
    }

    await bridge.storage.set(MIGRATION_STORE, MIGRATION_KEY, { kind: "json", value: { completed: true, completedAt: new Date().toISOString() } });
    return true;
}
