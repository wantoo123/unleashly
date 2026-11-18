import { app, dialog, type BrowserWindow, type Session } from "electron";
import { basename, isAbsolute, join } from "node:path";

import { log } from "./logger";

export function setupDownloads(session: Session, window: BrowserWindow) {
    session.on("will-download", (_event, item) => {
        const filename = basename(item.getFilename() || "download");
        const defaultPath = join(app.getPath("downloads"), filename);
        const result = dialog.showSaveDialogSync(window, {
            title: "保存文件",
            defaultPath,
            buttonLabel: "保存",
        });
        if (!result || !isAbsolute(result)) {
            item.cancel();
            log.info("Download canceled", { filename });
            return;
        }
        item.setSavePath(result);
        item.once("done", (_doneEvent, state) => {
            log.info("Download finished", { path: result, state });
        });
    });
}
