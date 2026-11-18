export const IPC = {
    appInfo: "app:info",
    appShowMenu: "app:show-menu",
    windowMinimize: "window:minimize",
    windowToggleMaximize: "window:toggle-maximize",
    windowClose: "window:close",
    windowIsMaximized: "window:is-maximized",
    windowMaximizedChanged: "window:maximized-changed",
    nativeSaveFile: "native:save-file",
    nativeOpenFiles: "native:open-files",
    nativeShowItemInFolder: "native:show-item-in-folder",
    storageGet: "storage:get",
    storageSet: "storage:set",
    storageRemove: "storage:remove",
    storageKeys: "storage:keys",
    storageClear: "storage:clear",
    storageStats: "storage:stats",
    secretsGet: "secrets:get",
    secretsSet: "secrets:set",
    secretsDelete: "secrets:delete",
    secretsList: "secrets:list",
    proxyInfo: "proxy:info",
    tasksEnqueue: "tasks:enqueue",
    tasksList: "tasks:list",
    tasksGet: "tasks:get",
    tasksResult: "tasks:result",
    tasksCancel: "tasks:cancel",
    tasksRetry: "tasks:retry",
    tasksRemove: "tasks:remove",
    tasksClearFinished: "tasks:clear-finished",
    tasksStats: "tasks:stats",
    tasksSyncChannels: "tasks:sync-channels",
    tasksGetConcurrency: "tasks:get-concurrency",
    tasksSetConcurrency: "tasks:set-concurrency",
    tasksChanged: "tasks:changed",
    tasksDelta: "tasks:delta",
    tasksOpen: "tasks:open",
    logsWrite: "logs:write",
    diagnosticsSummary: "diagnostics:summary",
    diagnosticsExport: "diagnostics:export",
    diagnosticsListCrashes: "diagnostics:list-crashes",
    diagnosticsClearCrashes: "diagnostics:clear-crashes",
    diagnosticsOpenLogs: "diagnostics:open-logs",
    diagnosticsOpenCrashes: "diagnostics:open-crashes",
    diagnosticsReportCrash: "diagnostics:report-crash",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export type FileFilter = {
    name: string;
    extensions: string[];
};

export type AppInfo = {
    version: string;
    platform: string;
    userData: string;
    isPackaged: boolean;
};

export type StoragePayload = { kind: "string"; value: string } | { kind: "binary"; mimeType: string; data: ArrayBuffer } | { kind: "json"; value: unknown };

export type StorageStats = {
    totalBytes: number;
    stores: Array<{ name: string; records: number; bytes: number }>;
};

export type SaveFileRequest = {
    defaultPath?: string;
    filters?: FileFilter[];
    data: ArrayBuffer | string;
};

export type SaveFileResult = {
    canceled: boolean;
    filePath?: string;
};

export type OpenedFile = {
    name: string;
    path: string;
    size: number;
    mimeType: string;
    data: ArrayBuffer;
};

export type OpenFilesResult = {
    canceled: boolean;
    files: OpenedFile[];
};

export type ProxyInfo = {
    url: string;
};
