import localforage from "localforage";

import { getDesktopBridge } from "../bridge";
import { DESKTOP_STORAGE_DRIVER } from "./desktop-driver";

/**
 * Create a localforage instance for application data.
 *
 * localforage's createInstance() does not inherit the default driver that was
 * selected with setDriver(), so desktop instances must opt into the file driver
 * explicitly. The browser build keeps the default IndexedDB driver.
 */
export function createAppStorage(options: { name: string; storeName: string }) {
    if (!getDesktopBridge() || !localforage.supports(DESKTOP_STORAGE_DRIVER)) return localforage.createInstance(options);
    return localforage.createInstance({ ...options, driver: DESKTOP_STORAGE_DRIVER });
}
