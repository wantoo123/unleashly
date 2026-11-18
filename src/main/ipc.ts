import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

import type { AppInfo, FileFilter, OpenFilesResult, OpenedFile, ProxyInfo, SaveFileRequest, SaveFileResult, StoragePayload } from "@shared/ipc";
import { IPC } from "@shared/ipc";
import type { CrashReportKind, DiagnosticsExportRequest, LogWriteRequest, RendererCrashReport } from "@shared/diagnostics";
import type { EnqueueTaskRequest, GatewayChannel, GatewayApiFormat, TaskConcurrency, TaskKind, TaskListFilter, TaskPriority, TaskStatus } from "@shared/tasks";
import { showAppMenu } from "./menu";
import { recordCrash, listCrashReports } from "./services/crash-reports";
import { clearCrashReportDirectory, exportDiagnostics, getDiagnosticsSummary, openCrashReportDirectory, openLogDirectory } from "./services/diagnostics";
import { fileStorage } from "./services/file-storage";
import { getProxyUrl } from "./services/local-proxy";
import { log, scopedLogger } from "./services/logger";
import { secretVault } from "./services/secret-vault";
import { getTaskQueue } from "./services/task-service";

const MAX_OPEN_FILE_BYTES = 512 * 1024 * 1024;
const TASK_ID_PATTERN = /^task_[A-Za-z0-9-]{8,}$/;
const TASK_STATUSES = new Set<TaskStatus | "active" | "all">(["queued", "running", "succeeded", "failed", "canceled", "active", "all"]);
const TASK_KINDS = new Set<TaskKind | "all">(["image", "video", "audio", "text", "model3d", "all"]);
const TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high"]);
const API_FORMATS = new Set<GatewayApiFormat>(["openai", "gemini"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const RENDERER_CRASH_KINDS = new Set<CrashReportKind>(["renderer-error", "renderer-unhandled-rejection", "renderer-react-error", "renderer-bootstrap-error"]);

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".json": "application/json",
    ".zip": "application/zip",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".obj": "model/obj",
    ".fbx": "application/octet-stream",
    ".usdz": "model/vnd.usdz+zip",
};

function assertTrustedSender(event: IpcMainInvokeEvent) {
    const url = event.senderFrame?.url || "";
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith("app://unleashly/")) return;
    throw new Error("Untrusted IPC sender");
}

function assertStore(value: unknown): asserts value is string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error("Invalid storage store");
}

function assertKey(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid storage key");
}

function assertPayload(value: unknown): asserts value is StoragePayload {
    if (!value || typeof value !== "object") throw new Error("Invalid storage payload");
    const payload = value as Partial<StoragePayload>;
    if (payload.kind === "string" && typeof payload.value === "string") return;
    if (payload.kind === "json") return;
    if (payload.kind === "binary" && typeof payload.mimeType === "string" && (payload.data instanceof ArrayBuffer || ArrayBuffer.isView(payload.data))) return;
    throw new Error("Invalid storage payload");
}

function assertSecretId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new Error("Invalid secret id");
}

function assertTaskId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) throw new Error("Invalid task id");
}

function sanitizeTaskFilter(value: unknown): TaskListFilter {
    const input = (value || {}) as Partial<TaskListFilter>;
    return {
        ...(TASK_STATUSES.has(input.status as TaskStatus | "active" | "all") ? { status: input.status } : {}),
        ...(TASK_KINDS.has(input.kind as TaskKind | "all") ? { kind: input.kind } : {}),
        ...(typeof input.includeHidden === "boolean" ? { includeHidden: input.includeHidden } : {}),
        ...(typeof input.limit === "number" && Number.isFinite(input.limit) ? { limit: Math.max(1, Math.min(1000, Math.floor(input.limit))) } : {}),
        ...(typeof input.offset === "number" && Number.isFinite(input.offset) ? { offset: Math.max(0, Math.floor(input.offset)) } : {}),
    };
}

function sanitizeEnqueueRequest(value: unknown): EnqueueTaskRequest {
    if (!value || typeof value !== "object") throw new Error("Invalid task request");
    const input = value as Partial<EnqueueTaskRequest>;
    if (!input.request || typeof input.request !== "object") throw new Error("Invalid task payload");
    if (input.priority !== undefined && !TASK_PRIORITIES.has(input.priority)) throw new Error("Invalid task priority");
    if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200)) throw new Error("Invalid task title");
    if (input.origin !== undefined && (typeof input.origin !== "string" || input.origin.length > 80)) throw new Error("Invalid task origin");
    if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId.length > 120)) throw new Error("Invalid task batch");
    if (input.maxAttempts !== undefined && (!Number.isFinite(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5)) throw new Error("Invalid task attempts");
    return input as EnqueueTaskRequest;
}

function sanitizeChannels(value: unknown): GatewayChannel[] {
    if (!Array.isArray(value)) throw new Error("Invalid channel list");
    return value.slice(0, 64).map((item) => {
        if (!item || typeof item !== "object") throw new Error("Invalid channel");
        const channel = item as Partial<GatewayChannel>;
        if (typeof channel.id !== "string" || !channel.id || channel.id.length > 128) throw new Error("Invalid channel id");
        if (typeof channel.name !== "string" || channel.name.length > 200) throw new Error("Invalid channel name");
        if (typeof channel.baseUrl !== "string" || channel.baseUrl.length > 2048) throw new Error("Invalid channel base URL");
        if (typeof channel.apiKey !== "string" || channel.apiKey.length > 4096) throw new Error("Invalid channel key");
        if (!API_FORMATS.has(channel.apiFormat as GatewayApiFormat)) throw new Error("Invalid channel format");
        const models = Array.isArray(channel.models)
            ? channel.models
                  .slice(0, 500)
                  .filter((model) => model && typeof model.name === "string")
                  .map((model) => ({ name: String(model.name).slice(0, 256), capability: String(model.capability || "text").slice(0, 32), ...(typeof model.script === "string" ? { script: model.script.slice(0, 20000) } : {}) }))
            : [];
        return { id: channel.id, name: channel.name, baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat as GatewayApiFormat, models };
    });
}

function sanitizeConcurrency(value: unknown): Partial<TaskConcurrency> & { perKind?: Partial<TaskConcurrency["perKind"]> } {
    const input = (value || {}) as Partial<TaskConcurrency> & { perKind?: Partial<TaskConcurrency["perKind"]> };
    const clamp = (next: unknown) => (typeof next === "number" && Number.isFinite(next) ? Math.max(1, Math.min(8, Math.floor(next))) : undefined);
    const global = clamp(input.global);
    const perKind =
        input.perKind && typeof input.perKind === "object" ? Object.fromEntries((["image", "video", "audio", "text", "model3d"] as TaskKind[]).map((kind) => [kind, clamp(input.perKind?.[kind])]).filter(([, value]) => value !== undefined)) : undefined;
    return { ...(global !== undefined ? { global } : {}), ...(perKind ? { perKind } : {}) };
}

function sanitizeLogRequest(value: unknown): LogWriteRequest {
    if (!value || typeof value !== "object") throw new Error("Invalid log request");
    const input = value as Partial<LogWriteRequest>;
    if (typeof input.level !== "string" || !LOG_LEVELS.has(input.level)) throw new Error("Invalid log level");
    if (typeof input.message !== "string" || !input.message || input.message.length > 16_000) throw new Error("Invalid log message");
    return { level: input.level as LogWriteRequest["level"], message: input.message, ...(input.meta !== undefined ? { meta: input.meta } : {}) };
}

function sanitizeRendererCrash(value: unknown): RendererCrashReport {
    if (!value || typeof value !== "object") throw new Error("Invalid crash report");
    const input = value as Partial<RendererCrashReport>;
    if (typeof input.kind !== "string" || !RENDERER_CRASH_KINDS.has(input.kind as CrashReportKind)) throw new Error("Invalid crash report kind");
    if (typeof input.message !== "string" || !input.message || input.message.length > 8_000) throw new Error("Invalid crash report message");
    if (input.stack !== undefined && (typeof input.stack !== "string" || input.stack.length > 32_000)) throw new Error("Invalid crash report stack");
    if (input.source !== undefined && (typeof input.source !== "string" || input.source.length > 2_048)) throw new Error("Invalid crash report source");
    if (input.metadata !== undefined) {
        try {
            const json = JSON.stringify(input.metadata);
            if (!json || json.length > 32_000) throw new Error("Invalid crash metadata size");
        } catch {
            throw new Error("Invalid crash metadata");
        }
    }
    return input as RendererCrashReport;
}

function sanitizeDiagnosticsExport(value: unknown): DiagnosticsExportRequest {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object") throw new Error("Invalid diagnostics request");
    const input = value as Partial<DiagnosticsExportRequest>;
    const note = typeof input.note === "string" ? input.note.slice(0, 2_000) : undefined;
    let rendererConfig: unknown;
    if (input.rendererConfig !== undefined) {
        try {
            const json = JSON.stringify(input.rendererConfig);
            if (json && json.length <= 512_000) rendererConfig = input.rendererConfig;
        } catch {
            // Skip unserializable snapshots.
        }
    }
    return { ...(rendererConfig !== undefined ? { rendererConfig } : {}), ...(note ? { note } : {}) };
}

function mimeTypeFor(path: string) {
    return MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function filtersOrDefault(filters?: FileFilter[]): FileFilter[] {
    return filters?.length ? filters : [{ name: "文件", extensions: ["*"] }];
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null) {
    ipcMain.handle(IPC.appInfo, (event): AppInfo => {
        assertTrustedSender(event);
        return {
            version: app.getVersion(),
            platform: process.platform,
            userData: app.getPath("userData"),
            isPackaged: app.isPackaged,
        };
    });

    ipcMain.handle(IPC.appShowMenu, (event) => {
        assertTrustedSender(event);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) showAppMenu(window);
    });

    ipcMain.handle(IPC.windowMinimize, (event) => {
        assertTrustedSender(event);
        BrowserWindow.fromWebContents(event.sender)?.minimize();
    });

    ipcMain.handle(IPC.windowToggleMaximize, (event) => {
        assertTrustedSender(event);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
    });

    ipcMain.handle(IPC.windowClose, (event) => {
        assertTrustedSender(event);
        BrowserWindow.fromWebContents(event.sender)?.close();
    });

    ipcMain.handle(IPC.windowIsMaximized, (event) => {
        assertTrustedSender(event);
        return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
    });

    ipcMain.handle(IPC.storageGet, async (event, store: unknown, key: unknown) => {
        assertTrustedSender(event);
        assertStore(store);
        assertKey(key);
        return fileStorage.get(store, key);
    });

    ipcMain.handle(IPC.storageSet, async (event, store: unknown, key: unknown, payload: unknown) => {
        assertTrustedSender(event);
        assertStore(store);
        assertKey(key);
        assertPayload(payload);
        await fileStorage.set(store, key, payload);
    });

    ipcMain.handle(IPC.storageRemove, async (event, store: unknown, key: unknown) => {
        assertTrustedSender(event);
        assertStore(store);
        assertKey(key);
        await fileStorage.remove(store, key);
    });

    ipcMain.handle(IPC.storageKeys, async (event, store: unknown) => {
        assertTrustedSender(event);
        assertStore(store);
        return fileStorage.keys(store);
    });

    ipcMain.handle(IPC.storageClear, async (event, store: unknown) => {
        assertTrustedSender(event);
        assertStore(store);
        await fileStorage.clear(store);
    });

    ipcMain.handle(IPC.storageStats, async (event) => {
        assertTrustedSender(event);
        return fileStorage.stats();
    });

    ipcMain.handle(IPC.secretsGet, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertSecretId(id);
        return secretVault.get(id);
    });

    ipcMain.handle(IPC.secretsSet, async (event, id: unknown, value: unknown) => {
        assertTrustedSender(event);
        assertSecretId(id);
        if (typeof value !== "string") throw new Error("Invalid secret value");
        await secretVault.set(id, value);
    });

    ipcMain.handle(IPC.secretsDelete, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertSecretId(id);
        await secretVault.remove(id);
    });

    ipcMain.handle(IPC.secretsList, async (event) => {
        assertTrustedSender(event);
        return secretVault.list();
    });

    ipcMain.handle(IPC.proxyInfo, (event): ProxyInfo => {
        assertTrustedSender(event);
        return { url: getProxyUrl() };
    });

    ipcMain.handle(IPC.nativeSaveFile, async (event, request: unknown): Promise<SaveFileResult> => {
        assertTrustedSender(event);
        const options = request as Partial<SaveFileRequest> | null;
        if (!options || (typeof options.data !== "string" && !(options.data instanceof ArrayBuffer) && !ArrayBuffer.isView(options.data))) {
            throw new Error("Invalid save request");
        }
        const defaultPath = options.defaultPath ? (isAbsolute(options.defaultPath) ? options.defaultPath : join(app.getPath("downloads"), basename(options.defaultPath))) : undefined;
        const parent = getWindow();
        const dialogOptions = {
            title: "保存文件",
            defaultPath,
            filters: filtersOrDefault(options.filters),
        };
        const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
        if (result.canceled || !result.filePath) return { canceled: true };
        await mkdir(dirname(result.filePath), { recursive: true });
        if (typeof options.data === "string") {
            await writeFile(result.filePath, options.data, "utf8");
        } else {
            await writeFile(result.filePath, Buffer.from(new Uint8Array(options.data as ArrayBuffer)));
        }
        return { canceled: false, filePath: result.filePath };
    });

    ipcMain.handle(IPC.nativeOpenFiles, async (event, options: unknown): Promise<OpenFilesResult> => {
        assertTrustedSender(event);
        const input = (options || {}) as { filters?: FileFilter[]; multi?: boolean };
        const parent = getWindow();
        const dialogOptions = {
            title: "打开文件",
            properties: (input.multi ? ["openFile", "multiSelections"] : ["openFile"]) as Array<"openFile" | "multiSelections">,
            filters: filtersOrDefault(input.filters),
        };
        const result = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled) return { canceled: true, files: [] };
        const files: OpenedFile[] = [];
        for (const path of result.filePaths) {
            try {
                const info = await stat(path);
                if (!info.isFile() || info.size > MAX_OPEN_FILE_BYTES) {
                    log.warn("Skipped unsupported file", { path, size: info.size });
                    continue;
                }
                const data = await readFile(path);
                const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
                files.push({ name: basename(path), path, size: info.size, mimeType: mimeTypeFor(path), data: arrayBuffer });
            } catch (error) {
                log.warn("Failed to read selected file", { path, error });
            }
        }
        return { canceled: false, files };
    });

    ipcMain.handle(IPC.nativeShowItemInFolder, async (event, path: unknown) => {
        assertTrustedSender(event);
        if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Invalid path");
        shell.showItemInFolder(path);
    });

    ipcMain.handle(IPC.tasksEnqueue, async (event, request: unknown) => {
        assertTrustedSender(event);
        return getTaskQueue().enqueue(sanitizeEnqueueRequest(request));
    });

    ipcMain.handle(IPC.tasksList, async (event, filter: unknown) => {
        assertTrustedSender(event);
        return getTaskQueue().list(sanitizeTaskFilter(filter));
    });

    ipcMain.handle(IPC.tasksGet, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertTaskId(id);
        return getTaskQueue().get(id);
    });

    ipcMain.handle(IPC.tasksResult, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertTaskId(id);
        return getTaskQueue().getResult(id);
    });

    ipcMain.handle(IPC.tasksCancel, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertTaskId(id);
        return getTaskQueue().cancel(id);
    });

    ipcMain.handle(IPC.tasksRetry, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertTaskId(id);
        return getTaskQueue().retry(id);
    });

    ipcMain.handle(IPC.tasksRemove, async (event, id: unknown) => {
        assertTrustedSender(event);
        assertTaskId(id);
        await getTaskQueue().remove(id);
    });

    ipcMain.handle(IPC.tasksClearFinished, async (event) => {
        assertTrustedSender(event);
        return getTaskQueue().clearFinished();
    });

    ipcMain.handle(IPC.tasksStats, async (event) => {
        assertTrustedSender(event);
        return getTaskQueue().stats();
    });

    ipcMain.handle(IPC.tasksSyncChannels, async (event, channels: unknown) => {
        assertTrustedSender(event);
        getTaskQueue().syncChannels(sanitizeChannels(channels));
    });

    ipcMain.handle(IPC.tasksGetConcurrency, (event) => {
        assertTrustedSender(event);
        return getTaskQueue().getConcurrency();
    });

    ipcMain.handle(IPC.tasksSetConcurrency, async (event, concurrency: unknown) => {
        assertTrustedSender(event);
        return getTaskQueue().setConcurrency(sanitizeConcurrency(concurrency));
    });

    ipcMain.handle(IPC.logsWrite, (event, request: unknown) => {
        assertTrustedSender(event);
        const entry = sanitizeLogRequest(request);
        scopedLogger("renderer")[entry.level](entry.message, ...(entry.meta !== undefined ? [entry.meta] : []));
    });

    ipcMain.handle(IPC.diagnosticsSummary, async (event) => {
        assertTrustedSender(event);
        return getDiagnosticsSummary();
    });

    ipcMain.handle(IPC.diagnosticsExport, async (event, request: unknown) => {
        assertTrustedSender(event);
        return exportDiagnostics(BrowserWindow.fromWebContents(event.sender), sanitizeDiagnosticsExport(request));
    });

    ipcMain.handle(IPC.diagnosticsListCrashes, async (event) => {
        assertTrustedSender(event);
        return listCrashReports(50);
    });

    ipcMain.handle(IPC.diagnosticsClearCrashes, async (event) => {
        assertTrustedSender(event);
        return clearCrashReportDirectory();
    });

    ipcMain.handle(IPC.diagnosticsOpenLogs, async (event) => {
        assertTrustedSender(event);
        await openLogDirectory();
    });

    ipcMain.handle(IPC.diagnosticsOpenCrashes, async (event) => {
        assertTrustedSender(event);
        await openCrashReportDirectory();
    });

    ipcMain.handle(IPC.diagnosticsReportCrash, async (event, report: unknown) => {
        assertTrustedSender(event);
        const input = sanitizeRendererCrash(report);
        await recordCrash({
            kind: input.kind,
            process: "renderer",
            message: input.message,
            stack: input.stack,
            source: input.source || event.senderFrame?.url || "",
            line: input.line,
            column: input.column,
            metadata: {
                ...(input.metadata || {}),
                windowUrl: event.senderFrame?.url || "",
            },
        });
    });
}
