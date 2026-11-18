import localforage from "localforage";

import { getDesktopBridge } from "../bridge";
import { DESKTOP_STORAGE_DRIVER, defineDesktopStorageDriver } from "./desktop-driver";
import { migrateLegacyStorage } from "./migration";

export async function bootstrapDesktopStorage() {
    const bridge = getDesktopBridge();
    if (!bridge) return;

    if (!defineDesktopStorageDriver()) return;

    try {
        const ready = await migrateLegacyStorage();
        if (!ready) return;
        await localforage.setDriver(DESKTOP_STORAGE_DRIVER);
    } catch (error) {
        console.error("[storage] Desktop storage initialization failed; using IndexedDB instead", error);
    }
}
