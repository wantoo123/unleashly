import { saveAs } from "file-saver";

import type { FileFilter } from "@shared/ipc";
import { getDesktopBridge } from "./bridge";

/**
 * Save a blob or an already-loaded data/blob URL.
 * Desktop uses a native save dialog; the browser build keeps file-saver.
 */
export async function saveFile(input: Blob | string, fileName: string, filters?: FileFilter[]) {
    const bridge = getDesktopBridge();
    if (!bridge) {
        saveAs(input, fileName);
        return true;
    }

    // Remote URLs are handled by the download pipeline, which already prompts for a path.
    if (typeof input === "string" && !/^(data:|blob:)/i.test(input)) {
        saveAs(input, fileName);
        return true;
    }

    try {
        const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
        const result = await bridge.native.saveFile({
            defaultPath: fileName,
            filters,
            data: await blob.arrayBuffer(),
        });
        return !result.canceled;
    } catch (error) {
        console.warn("[files] Native save failed; falling back to browser download", error);
        saveAs(input, fileName);
        return true;
    }
}

export const ZIP_FILTERS: FileFilter[] = [{ name: "ZIP", extensions: ["zip"] }];
