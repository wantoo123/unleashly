import { app, dialog, Menu, shell, type BrowserWindow } from "electron";

import { exportDiagnostics, openCrashReportDirectory } from "./services/diagnostics";
import { log } from "./services/logger";
import { showTaskCenter } from "./services/task-service";
import { checkForUpdates } from "./services/updater";

export function buildAppMenu(getWindow: () => BrowserWindow | null) {
    const isMac = process.platform === "darwin";
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (isMac) {
        template.push({
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
        });
    }

    template.push({
        label: "文件",
        submenu: [
            {
                label: "任务中心",
                accelerator: "CmdOrCtrl+Shift+T",
                click: () => showTaskCenter(),
            },
            { type: "separator" },
            {
                label: "打开数据目录",
                click: () => {
                    void shell.openPath(app.getPath("userData")).catch((error) => log.warn("Failed to open data directory", error));
                },
            },
            {
                label: "打开日志目录",
                click: () => {
                    void shell.openPath(`${app.getPath("userData")}/logs`).catch((error) => log.warn("Failed to open log directory", error));
                },
            },
            {
                label: "打开崩溃报告目录",
                click: () => {
                    void openCrashReportDirectory().catch((error) => log.warn("Failed to open crash report directory", error));
                },
            },
            {
                label: "导出诊断包…",
                click: () => {
                    void exportDiagnostics(getWindow()).catch((error) => log.warn("Failed to export diagnostics", error));
                },
            },
            { type: "separator" },
            ...(isMac ? [] : [{ role: "quit" as const }]),
        ],
    });

    template.push({
        label: "编辑",
        submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    });

    template.push({
        label: "视图",
        submenu: [
            { role: "reload" },
            { role: "forceReload" },
            ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
        ],
    });

    template.push({
        label: "窗口",
        submenu: [{ role: "minimize" }, ...(isMac ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }])],
    });

    template.push({
        label: "帮助",
        submenu: [
            {
                label: "检查更新…",
                click: () => {
                    void showUpdateCheck(getWindow());
                },
            },
            { type: "separator" },
            {
                label: "关于 Unleashly",
                click: () => {
                    void dialogShowAbout(getWindow());
                },
            },
        ],
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function showAppMenu(window: BrowserWindow) {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: "任务中心",
            click: () => showTaskCenter(),
        },
        { type: "separator" },
        {
            label: "打开数据目录",
            click: () => {
                void shell.openPath(app.getPath("userData")).catch((error) => log.warn("Failed to open data directory", error));
            },
        },
        {
            label: "打开日志目录",
            click: () => {
                void shell.openPath(`${app.getPath("userData")}/logs`).catch((error) => log.warn("Failed to open log directory", error));
            },
        },
        {
            label: "打开崩溃报告目录",
            click: () => {
                void openCrashReportDirectory().catch((error) => log.warn("Failed to open crash report directory", error));
            },
        },
        {
            label: "导出诊断包…",
            click: () => {
                void exportDiagnostics(window).catch((error) => log.warn("Failed to export diagnostics", error));
            },
        },
        { type: "separator" },
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { role: "togglefullscreen" },
        { type: "separator" },
        {
            label: "检查更新…",
            click: () => {
                void showUpdateCheck(window);
            },
        },
        {
            label: "关于 Unleashly",
            click: () => {
                void dialogShowAbout(window);
            },
        },
        ...(process.platform === "darwin" ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
    ];
    Menu.buildFromTemplate(template).popup({ window });
}

async function showUpdateCheck(window: BrowserWindow | null) {
    const status = await checkForUpdates(true);
    const message =
        status.phase === "available" && status.info
            ? `发现新版本 ${status.info.version}`
            : status.phase === "not-available"
              ? "当前已是最新版本"
              : status.phase === "disabled"
                ? "当前构建不支持自动更新"
                : status.phase === "downloading"
                  ? "新版本正在下载"
                  : status.phase === "downloaded" && status.info
                    ? `新版本 ${status.info.version} 已下载`
                    : "检查更新失败";
    const detail = status.phase === "available" ? "点击顶部版本号打开版本信息，然后下载并安装更新。" : status.phase === "error" ? status.error || "" : status.phase === "disabled" ? status.message || "请安装正式发布版本后再检查更新。" : "";
    const options = {
        type: status.phase === "error" ? ("warning" as const) : ("info" as const),
        title: "检查更新",
        message,
        detail,
        buttons: ["确定"],
    };
    if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
}

async function dialogShowAbout(window: BrowserWindow | null) {
    const options = {
        type: "info" as const,
        title: "关于 Unleashly",
        message: `Unleashly ${app.getVersion()}`,
        detail: "本地优先的 AI 视觉创作工作台",
        buttons: ["确定"],
    };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
}
