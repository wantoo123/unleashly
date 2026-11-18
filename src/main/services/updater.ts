import { app, BrowserWindow } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";

import { IPC } from "@shared/ipc";
import type { UpdateInfoSummary, UpdateStatus } from "@shared/updates";

import { log } from "./logger";

const AUTO_CHECK_DELAY_MS = 10_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type UpdaterOptions = {
    /** Called before quitAndInstall so the task queue can persist and stop cleanly. */
    beforeInstall: () => Promise<void>;
};

let options: UpdaterOptions | null = null;
let initialized = false;
let checking: Promise<UpdateStatus> | null = null;
let autoCheckTimer: NodeJS.Timeout | null = null;
let autoCheckInterval: NodeJS.Timeout | null = null;
let status: UpdateStatus = {
    phase: app.isPackaged ? "idle" : "disabled",
    currentVersion: app.getVersion(),
    ...(app.isPackaged ? {} : { message: "Updates are only available in packaged builds" }),
};

function now() {
    return new Date().toISOString();
}

function notesToString(info: UpdateInfo) {
    const notes = info.releaseNotes;
    if (typeof notes === "string") return notes;
    if (Array.isArray(notes))
        return notes
            .map((item) => item.note || "")
            .filter(Boolean)
            .join("\n\n");
    return undefined;
}

function summarize(info: UpdateInfo): UpdateInfoSummary {
    return {
        version: info.version,
        ...(info.releaseName ? { releaseName: info.releaseName } : {}),
        ...(notesToString(info) ? { releaseNotes: notesToString(info) } : {}),
        ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
    };
}

function normalizeProgress(progress: ProgressInfo) {
    return {
        percent: Math.max(0, Math.min(100, Math.round(progress.percent * 100) / 100)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
    };
}

function broadcast(next: UpdateStatus) {
    status = next;
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
        window.webContents.send(IPC.updatesChanged, next);
    }
    return { ...next };
}

function update(patch: Partial<UpdateStatus>) {
    return broadcast({ ...status, ...patch, currentVersion: app.getVersion() });
}

function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[updater] Update failed", error);
    return update({ phase: "error", error: message, checkedAt: now() });
}

function configure() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
        info: (message?: unknown) => log.info("[updater]", message),
        warn: (message?: unknown) => log.warn("[updater]", message),
        error: (message?: unknown) => log.error("[updater]", message),
        debug: (message: string) => log.debug("[updater]", message),
    };

    autoUpdater.on("checking-for-update", () => {
        update({ phase: "checking", error: undefined, progress: undefined });
    });
    autoUpdater.on("update-available", (info) => {
        log.info("[updater] Update available", { version: info.version });
        update({ phase: "available", info: summarize(info), error: undefined, progress: undefined });
    });
    autoUpdater.on("update-not-available", (info) => {
        log.info("[updater] No update available", { version: info.version });
        update({ phase: "not-available", info: summarize(info), error: undefined, progress: undefined, checkedAt: now() });
    });
    autoUpdater.on("download-progress", (progress) => {
        update({ phase: "downloading", progress: normalizeProgress(progress), error: undefined });
    });
    autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
        log.info("[updater] Update downloaded", { version: event.version, file: event.downloadedFile });
        update({ phase: "downloaded", info: summarize(event), progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined, checkedAt: now() });
    });
    autoUpdater.on("error", (error) => {
        fail(error);
    });
}

export function getUpdateStatus(): UpdateStatus {
    return { ...status };
}

export async function checkForUpdates(manual = false): Promise<UpdateStatus> {
    if (!app.isPackaged) {
        return update({ phase: "disabled", message: "Updates are only available in packaged builds", checkedAt: now() });
    }
    if (checking) return checking;
    if (status.phase === "downloading") return getUpdateStatus();
    if (status.phase === "downloaded") return getUpdateStatus();
    if (manual) log.info("[updater] Manual update check requested");

    update({ phase: "checking", error: undefined, message: undefined });
    checking = (async () => {
        try {
            const result = await autoUpdater.checkForUpdates();
            // Event handlers normally update the state. If they did not fire (for
            // example a provider returns a result without emitting), reconcile.
            if (status.phase === "checking") {
                if (result?.isUpdateAvailable) {
                    return update({ phase: "available", info: summarize(result.updateInfo), checkedAt: now() });
                }
                return update({
                    phase: "not-available",
                    ...(result?.updateInfo ? { info: summarize(result.updateInfo) } : {}),
                    checkedAt: now(),
                });
            }
            return getUpdateStatus();
        } catch (error) {
            return fail(error);
        } finally {
            checking = null;
        }
    })();
    return checking;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
    if (!app.isPackaged) return getUpdateStatus();
    if (status.phase === "downloaded") return getUpdateStatus();
    if (status.phase !== "available" && status.phase !== "error") return getUpdateStatus();
    if (!status.info) {
        const checked = await checkForUpdates(true);
        if (checked.phase !== "available") return checked;
    }
    log.info("[updater] Downloading update", { version: status.info?.version });
    update({ phase: "downloading", progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined });
    try {
        await autoUpdater.downloadUpdate();
        if (getUpdateStatus().phase !== "downloaded") {
            update({
                phase: "downloaded",
                progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
                checkedAt: now(),
            });
        }
        return getUpdateStatus();
    } catch (error) {
        return fail(error);
    }
}

export async function installUpdate(): Promise<void> {
    if (status.phase !== "downloaded") return;
    log.info("[updater] Installing update and restarting", { version: status.info?.version });
    try {
        await options?.beforeInstall();
        autoUpdater.quitAndInstall(false, true);
    } catch (error) {
        fail(error);
    }
}

export function initAutoUpdater(nextOptions: UpdaterOptions) {
    if (initialized) return;
    options = nextOptions;
    configure();
    if (!app.isPackaged) {
        log.info("[updater] Auto-update disabled in development build");
        return;
    }
    initialized = true;
    log.info("[updater] Initialized", { currentVersion: app.getVersion(), channel: "latest" });
    autoCheckTimer = setTimeout(() => void checkForUpdates(false), AUTO_CHECK_DELAY_MS);
    autoCheckTimer.unref?.();
    autoCheckInterval = setInterval(() => void checkForUpdates(false), AUTO_CHECK_INTERVAL_MS);
    autoCheckInterval.unref?.();
}

export function disposeAutoUpdater() {
    if (autoCheckTimer) clearTimeout(autoCheckTimer);
    if (autoCheckInterval) clearInterval(autoCheckInterval);
    autoCheckTimer = null;
    autoCheckInterval = null;
}
