import { app, Menu, nativeImage, Tray } from "electron";

import { log } from "./logger";

// 32x32 orange mark generated from the app logo. Embedded so the tray works in
// both development and packaged builds without relying on extraResources.
const TRAY_ICON =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEZklEQVR4nO2WTYgcRRTH/+9Vd9XMfmSXKEIgxCwShRU/iCi5SLK5uARRUCcQFDQQgohBJB48COMeg5iD4AeiXrzozsEc4kWQuCclejJm1YCHRPCQQL52Jt1dXVVPqmcWd5OZ7A4iQciDYWqmqvv93v99dANrmDSFm01h3AoTCK0EuSUQPx2UexYOyqa4Xr8SQt2z/wQwlElTOEZ/8oAcPXlAioUX/eXj++ybce/ETknWcr7q5xrQdMPlECKQ/HBINri2/ysENdouPRJSuNApDj9/rHY0QswskOvvnGR29oyZ2LJt85cf0x9rBcsDdy4ChZN25iB56f3FrHSKzbsfPtF+KTqfb4haFSi6kTYa2VR9curHpdL/suug+/6xA9lUFegAJXiQ/2QUzjqUZQBZD8pKr67mNoDMp0dm8j17W+QbKyC+a8Z7kVimfdiQPNBhYTehdmRj+oMqq8MqcN7A515K6yolUHqizHkpvGIr/v3Xd5yrt1oI1+c8T8m0FUJuSJYCgjW8/cF3ZHRujm442xdg+UR9I3zhpCx6AIWPEFBLNpOy5K06bLw3Rtxsrq6jawZS1MCZJi40WExIxV3R1aYMocCuuQhA1voegBPkEaYUcaTFap6M5xYXVwNYzcg0UGhADEA6DHIxCIAqztgJhQtlBeCjAoCN3yLINVNHU1/4axHAAEFH5wB0n7BXWNLvz+VWLLxYoggAsb00FCnBGSAfMGKsBjhG7mO9MqAE0EMCvN0tBbE+lHFhS0ERqgJDrlEBOO53qZDUoWLkFAKgAyiJtTcYgPv+2+uZwsFWRegFeULITQSgKsftvugkUG5zBaAFFJUwYq0u3VAAi73CKpxciTWQK1TOo/yFpljlsKmfjMPlNKDQlGQBCNNN0VyT3cJRfiGucyzCC7//eWeny7dOgOnzywB02ipIXmOJkUeILH40kI0kL2COwmKLLObIxbUfcUfUeLpF2PqoAI9CoPFz3GvMx6HVLfCVlvRV4K5u1rIEx0Pi38pT5gpAEwpDKoMTO5I8c/9h/5E1/Bmlbozr9DKPqkaQIpARhdR7aBBL+VV100b/FNCg3MTHaZxe+2c734axkd1XuHC5UUlssUoJTVJuYAoK4BpitAiSB6qBo/NkoqaCtM8sTV566OyurUXX040KMG5qQq428mo78W1b10muxXWVYBSGyYv3lDgRZUMIuScDRuIC1wmoAaJw6OzMVN5odZ8T/TzwINcx+jhmPz9Gv7ZTeS430inH0yTX5POUnKQ+sAkMLRKnXcw5Uu/UmGE1MaKCvfra6acmv4m5b+0lP8gP3VyB+HgV1WqRf/QVediZ8F4xxo9LvVc9aXfUUp3Ao9RLQ3EOofPGqafvaCEW3k2crwtgJURcb2uWe5ROnoVx25H6TVyTBDW5THX6DQZfszr/xakn7760HudDWb/3wfs+kfFH5mViel5WD9uq5f4ra4jq9vR1JsI7T0gCGe5FlP4VzLKzAS12227bbftf2N8HAVB356o9tAAAAABJRU5ErkJggg==";

type TrayActions = {
    showWindow: () => void;
    showTasks: () => void;
    quit: () => void;
};

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let running = 0;
let queued = 0;

function buildMenu() {
    const statusLabel = running ? `${running} 个任务运行中${queued ? `，${queued} 个等待中` : ""}` : queued ? `${queued} 个任务等待中` : "后台任务空闲";
    return Menu.buildFromTemplate([
        { label: statusLabel, enabled: false },
        { type: "separator" },
        { label: "打开任务中心", click: () => actions?.showTasks() },
        { label: "显示主窗口", click: () => actions?.showWindow() },
        { type: "separator" },
        { label: "退出 Unleashly", click: () => actions?.quit() },
    ]);
}

function refresh() {
    if (!tray) return;
    tray.setToolTip(`Unleashly${running ? ` · ${running} 个任务运行中` : ""}`);
    tray.setContextMenu(buildMenu());
}

export function createAppTray(nextActions: TrayActions) {
    actions = nextActions;
    if (tray) return tray;
    try {
        const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`);
        tray = new Tray(icon);
        tray.setToolTip("Unleashly");
        tray.setContextMenu(buildMenu());
        tray.on("click", () => actions?.showWindow());
        tray.on("double-click", () => actions?.showWindow());
        refresh();
        return tray;
    } catch (error) {
        log.warn("Failed to create tray icon", error);
        tray = null;
        return null;
    }
}

export function updateTrayTasks(nextRunning: number, nextQueued: number) {
    running = Math.max(0, nextRunning);
    queued = Math.max(0, nextQueued);
    refresh();
}

export function destroyAppTray() {
    if (!tray) return;
    tray.destroy();
    tray = null;
    actions = null;
}

export function quitFromTray() {
    app.quit();
}
