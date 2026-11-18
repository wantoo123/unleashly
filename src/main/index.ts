import { app, BrowserWindow, crashReporter, dialog } from "electron";
import { join } from "node:path";

import { registerIpcHandlers } from "./ipc";
import { buildAppMenu } from "./menu";
import { registerAppProtocol, registerAppScheme } from "./protocol";
import { recordCrash } from "./services/crash-reports";
import { setupDownloads } from "./services/downloads";
import { log } from "./services/logger";
import { startLocalProxy, stopLocalProxy } from "./services/local-proxy";
import { hasActiveTasks, initTaskService, notifyBackgroundGeneration, showTaskCenter, shutdownTaskService } from "./services/task-service";
import { createAppTray, destroyAppTray } from "./services/tray";
import { createMainWindow } from "./window";

app.enableSandbox();
app.setAppUserModelId("ai.unleashly.app");
registerAppScheme();

// Native crashpad collection starts before any window exists. Uploads are disabled:
// crash dumps stay local and are included in user-exported diagnostic bundles.
try {
    crashReporter.start({
        productName: "Unleashly",
        uploadToServer: false,
        compress: true,
        globalExtra: {
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            packaged: String(app.isPackaged),
        },
    });
} catch (error) {
    log.warn("Failed to start crash reporter", error);
}

// Optional CDP endpoint for local automated smoke tests and screenshots.
const debugPort = process.env.UNLEASHLY_DEBUG_PORT;
if (debugPort) app.commandLine.appendSwitch("remote-debugging-port", debugPort);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    let mainWindow: BrowserWindow | null = null;
    let isQuitting = false;
    let shutdownStarted = false;
    let lastCrashDialogAt = 0;

    const showMainWindow = () => {
        if (!mainWindow) {
            mainWindow = createMainWindow();
            mainWindow.on("closed", () => {
                mainWindow = null;
            });
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    };

    app.on("second-instance", () => {
        showMainWindow();
    });

    app.whenReady().then(async () => {
        log.info("Application starting", { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron });
        try {
            const lastCrash = crashReporter.getLastCrashReport();
            if (lastCrash) log.warn("Crashpad report available", lastCrash);
        } catch {
            // Crashpad status is best-effort.
        }
        registerAppProtocol(join(__dirname, "../renderer"));

        try {
            await initTaskService({ getWindow: () => mainWindow });
        } catch (error) {
            log.error("Failed to initialize task service", error);
        }

        registerIpcHandlers(() => mainWindow);

        try {
            await startLocalProxy();
        } catch (error) {
            log.error("Failed to start local proxy", error);
        }

        mainWindow = createMainWindow();
        mainWindow.on("closed", () => {
            mainWindow = null;
        });
        // Background generation: closing the window while tasks run keeps the app
        // alive in the tray; quitting explicitly still goes through before-quit.
        mainWindow.on("close", (event) => {
            if (isQuitting || !hasActiveTasks()) return;
            event.preventDefault();
            mainWindow?.hide();
            notifyBackgroundGeneration();
        });
        setupDownloads(mainWindow.webContents.session, mainWindow);
        buildAppMenu(() => mainWindow);
        createAppTray({
            showWindow: showMainWindow,
            showTasks: () => showTaskCenter(),
            quit: () => app.quit(),
        });

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                mainWindow = createMainWindow();
                mainWindow.on("closed", () => {
                    mainWindow = null;
                });
            } else {
                showMainWindow();
            }
        });
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", (event) => {
        isQuitting = true;
        if (shutdownStarted) return;
        shutdownStarted = true;
        log.info("Application quitting");
        event.preventDefault();
        void shutdownTaskService()
            .catch((error) => log.error("Failed to shut down task service", error))
            .finally(() => {
                stopLocalProxy();
                destroyAppTray();
                app.quit();
            });
    });

    app.on("quit", (_event, exitCode) => {
        log.info("Application quit", { exitCode });
    });

    app.on("render-process-gone", (_event, webContents, details) => {
        const url = (() => {
            try {
                return webContents.getURL();
            } catch {
                return "";
            }
        })();
        log.error("Renderer process gone", { url, details });
        void recordCrash({
            kind: "renderer-crash",
            process: "renderer",
            message: `Renderer process gone: ${details.reason}`,
            reason: details.reason,
            exitCode: details.exitCode,
            metadata: { url, type: webContents.getType?.(), details },
        });
        if (isQuitting || !["crashed", "oom", "integrity-failure", "launch-failed"].includes(details.reason)) return;
        const timestamp = Date.now();
        if (timestamp - lastCrashDialogAt < 60_000) return;
        lastCrashDialogAt = timestamp;
        void dialog
            .showMessageBox({
                type: "error",
                title: "Unleashly 界面进程崩溃",
                message: "界面进程意外退出",
                detail: `原因：${details.reason}\n退出码：${details.exitCode}\n\n崩溃报告已保存在本机，可在「配置 → 诊断」中查看或导出诊断包。`,
                buttons: ["重新加载界面", "暂不处理"],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            })
            .then((result) => {
                if (result.response !== 0 || isQuitting) return;
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
                else showMainWindow();
            })
            .catch((error) => log.warn("Failed to show renderer crash dialog", error));
    });

    app.on("child-process-gone", (_event, details) => {
        log.error("Child process gone", details);
        const processType = details.type === "GPU" ? "gpu" : details.type === "Utility" ? "utility" : "unknown";
        void recordCrash({
            kind: "child-process-gone",
            process: processType,
            message: `${details.type} process gone: ${details.reason}`,
            reason: details.reason,
            exitCode: details.exitCode,
            metadata: { type: details.type, serviceName: details.serviceName, name: details.name },
        });
    });

    process.on("uncaughtException", (error) => {
        log.error("Uncaught exception in main process", error);
        void recordCrash({
            kind: "main-uncaught-exception",
            process: "main",
            message: error?.message || String(error),
            stack: error?.stack,
            metadata: { name: error?.name },
        });
    });

    process.on("unhandledRejection", (reason) => {
        log.error("Unhandled rejection in main process", reason);
        const error = reason instanceof Error ? reason : undefined;
        void recordCrash({
            kind: "main-unhandled-rejection",
            process: "main",
            message: error?.message || (typeof reason === "string" ? reason : "Unhandled rejection"),
            stack: error?.stack,
        });
    });
}
