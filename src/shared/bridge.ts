import type { AppInfo, FileFilter, OpenFilesResult, ProxyInfo, SaveFileRequest, SaveFileResult, StoragePayload, StorageStats } from "./ipc";
import type { CrashReportSummary, DiagnosticsExportRequest, DiagnosticsExportResult, DiagnosticsSummary, LogWriteRequest, RendererCrashReport } from "./diagnostics";
import type { EnqueueTaskRequest, GatewayChannel, TaskConcurrency, TaskDeltaEvent, TaskListFilter, TaskOpenEvent, TaskRecord, TaskResultPayload, TaskStats } from "./tasks";

export type UnleashlyBridge = {
    platform: string;
    app: {
        info: () => Promise<AppInfo>;
        showMenu: () => Promise<void>;
    };
    windowControls: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<void>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (callback: (maximized: boolean) => void) => void;
    };
    storage: {
        get: (store: string, key: string) => Promise<StoragePayload | null>;
        set: (store: string, key: string, payload: StoragePayload) => Promise<void>;
        remove: (store: string, key: string) => Promise<void>;
        keys: (store: string) => Promise<string[]>;
        clear: (store: string) => Promise<void>;
        stats: () => Promise<StorageStats>;
    };
    secrets: {
        get: (id: string) => Promise<string | null>;
        set: (id: string, value: string) => Promise<void>;
        remove: (id: string) => Promise<void>;
        list: () => Promise<Record<string, string>>;
    };
    native: {
        saveFile: (request: SaveFileRequest) => Promise<SaveFileResult>;
        openFiles: (options?: { filters?: FileFilter[]; multi?: boolean }) => Promise<OpenFilesResult>;
        showItemInFolder: (path: string) => Promise<void>;
        getPathForFile: (file: File) => string;
    };
    proxy: {
        info: () => Promise<ProxyInfo>;
    };
    logs: {
        write: (request: LogWriteRequest) => Promise<void>;
    };
    diagnostics: {
        summary: () => Promise<DiagnosticsSummary>;
        export: (request?: DiagnosticsExportRequest) => Promise<DiagnosticsExportResult>;
        listCrashes: () => Promise<CrashReportSummary[]>;
        clearCrashes: () => Promise<number>;
        openLogs: () => Promise<void>;
        openCrashes: () => Promise<void>;
        reportCrash: (report: RendererCrashReport) => Promise<void>;
    };
    tasks: {
        enqueue: (request: EnqueueTaskRequest) => Promise<TaskRecord>;
        list: (filter?: TaskListFilter) => Promise<TaskRecord[]>;
        get: (id: string) => Promise<TaskRecord | null>;
        result: (id: string) => Promise<TaskResultPayload | null>;
        cancel: (id: string) => Promise<TaskRecord | null>;
        retry: (id: string) => Promise<TaskRecord | null>;
        remove: (id: string) => Promise<void>;
        clearFinished: () => Promise<number>;
        stats: () => Promise<TaskStats>;
        syncChannels: (channels: GatewayChannel[]) => Promise<void>;
        getConcurrency: () => Promise<TaskConcurrency>;
        setConcurrency: (concurrency: Partial<TaskConcurrency> & { perKind?: Partial<TaskConcurrency["perKind"]> }) => Promise<TaskConcurrency>;
        onChanged: (callback: (task: TaskRecord) => void) => void;
        onDelta: (callback: (event: TaskDeltaEvent) => void) => void;
        onOpen: (callback: (event: TaskOpenEvent) => void) => void;
    };
};
