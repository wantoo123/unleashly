import { app, BrowserWindow, session, shell } from "electron";
import { join } from "node:path";

import { IPC } from "@shared/ipc";
import { recordCrash } from "./services/crash-reports";
import { scopedLogger } from "./services/logger";

const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications"]);
const rendererLog = scopedLogger("renderer");

function isInternalUrl(url: string) {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return true;
    if (url.startsWith("app://unleashly/")) return true;
    return false;
}

function isExternalProtocol(url: string) {
    return /^(https?|mailto):/i.test(url);
}

function configureSession() {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission));
    });
    defaultSession.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

export function createMainWindow(): BrowserWindow {
    configureSession();
    const isMac = process.platform === "darwin";

    const window = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1080,
        minHeight: 720,
        show: false,
        backgroundColor: "#181715",
        autoHideMenuBar: false,
        title: "Unleashly",
        // Windows/Linux use a fully custom title bar. macOS keeps its native traffic
        // lights and only hides the title bar, which is the platform convention.
        ...(isMac ? { titleBarStyle: "hiddenInset" as const } : { frame: false, thickFrame: true }),
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    const notifyMaximized = () => {
        if (!window.isDestroyed()) window.webContents.send(IPC.windowMaximizedChanged, window.isMaximized());
    };
    window.on("maximize", notifyMaximized);
    window.on("unmaximize", notifyMaximized);

    window.once("ready-to-show", () => window.show());

    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalProtocol(url)) void shell.openExternal(url);
        return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, url) => {
        if (isInternalUrl(url)) return;
        event.preventDefault();
        if (isExternalProtocol(url)) void shell.openExternal(url);
    });

    window.webContents.on("will-attach-webview", (event) => event.preventDefault());

    // Forward renderer console output into the main log so a diagnostic bundle
    // captures plugin/model-script failures even when DevTools was never opened.
    if (process.env.UNLEASHLY_LOG_RENDERER_CONSOLE !== "0") {
        window.webContents.on("console-message", (details) => {
            const message = details?.message;
            if (!message) return;
            const rawLevel = details?.level || "info";
            const level = rawLevel === "warning" ? "warn" : rawLevel;
            const meta = { source: details?.sourceId || "", line: details?.lineNumber, windowId: window.id };
            const logger = level === "error" ? rendererLog.error : level === "warn" ? rendererLog.warn : level === "debug" ? rendererLog.debug : rendererLog.info;
            logger(message, meta);
        });
    }

    let unresponsiveReported = false;
    window.webContents.on("unresponsive", () => {
        rendererLog.warn("Renderer became unresponsive", { windowId: window.id });
        if (unresponsiveReported) return;
        unresponsiveReported = true;
        void recordCrash({
            kind: "renderer-unresponsive",
            process: "renderer",
            message: "Renderer became unresponsive",
            metadata: { windowId: window.id, url: window.webContents.getURL() },
        });
    });
    window.webContents.on("responsive", () => {
        unresponsiveReported = false;
        rendererLog.info("Renderer became responsive again", { windowId: window.id });
    });

    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) rendererLog.warn("Renderer failed to load", { errorCode, errorDescription, validatedURL, windowId: window.id });
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
        void window.loadURL(devUrl);
    } else {
        void window.loadURL("app://unleashly/index.html");
    }

    return window;
}
