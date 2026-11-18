import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { UnleashlyBridge } from "@shared/bridge";
import { IPC } from "@shared/ipc";

const bridge: UnleashlyBridge = {
    platform: process.platform,
    app: {
        info: () => ipcRenderer.invoke(IPC.appInfo),
        showMenu: () => ipcRenderer.invoke(IPC.appShowMenu),
    },
    windowControls: {
        minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
        toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
        close: () => ipcRenderer.invoke(IPC.windowClose),
        isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
        onMaximizedChange: (callback) => {
            ipcRenderer.on(IPC.windowMaximizedChanged, (_event, maximized: boolean) => callback(maximized));
        },
    },
    storage: {
        get: (store, key) => ipcRenderer.invoke(IPC.storageGet, store, key),
        set: (store, key, payload) => ipcRenderer.invoke(IPC.storageSet, store, key, payload),
        remove: (store, key) => ipcRenderer.invoke(IPC.storageRemove, store, key),
        keys: (store) => ipcRenderer.invoke(IPC.storageKeys, store),
        clear: (store) => ipcRenderer.invoke(IPC.storageClear, store),
        stats: () => ipcRenderer.invoke(IPC.storageStats),
    },
    secrets: {
        get: (id) => ipcRenderer.invoke(IPC.secretsGet, id),
        set: (id, value) => ipcRenderer.invoke(IPC.secretsSet, id, value),
        remove: (id) => ipcRenderer.invoke(IPC.secretsDelete, id),
        list: () => ipcRenderer.invoke(IPC.secretsList),
    },
    native: {
        saveFile: (request) => ipcRenderer.invoke(IPC.nativeSaveFile, request),
        openFiles: (options) => ipcRenderer.invoke(IPC.nativeOpenFiles, options),
        showItemInFolder: (path) => ipcRenderer.invoke(IPC.nativeShowItemInFolder, path),
        getPathForFile: (file) => webUtils.getPathForFile(file),
    },
    proxy: {
        info: () => ipcRenderer.invoke(IPC.proxyInfo),
    },
    logs: {
        write: (request) => ipcRenderer.invoke(IPC.logsWrite, request),
    },
    diagnostics: {
        summary: () => ipcRenderer.invoke(IPC.diagnosticsSummary),
        export: (request) => ipcRenderer.invoke(IPC.diagnosticsExport, request),
        listCrashes: () => ipcRenderer.invoke(IPC.diagnosticsListCrashes),
        clearCrashes: () => ipcRenderer.invoke(IPC.diagnosticsClearCrashes),
        openLogs: () => ipcRenderer.invoke(IPC.diagnosticsOpenLogs),
        openCrashes: () => ipcRenderer.invoke(IPC.diagnosticsOpenCrashes),
        reportCrash: (report) => ipcRenderer.invoke(IPC.diagnosticsReportCrash, report),
    },
    updates: {
        status: () => ipcRenderer.invoke(IPC.updatesStatus),
        check: () => ipcRenderer.invoke(IPC.updatesCheck),
        download: () => ipcRenderer.invoke(IPC.updatesDownload),
        install: () => ipcRenderer.invoke(IPC.updatesInstall),
        onStatus: (callback) => {
            const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status);
            ipcRenderer.on(IPC.updatesChanged, listener);
            return () => {
                ipcRenderer.off(IPC.updatesChanged, listener);
            };
        },
    },
    tasks: {
        enqueue: (request) => ipcRenderer.invoke(IPC.tasksEnqueue, request),
        list: (filter) => ipcRenderer.invoke(IPC.tasksList, filter),
        get: (id) => ipcRenderer.invoke(IPC.tasksGet, id),
        result: (id) => ipcRenderer.invoke(IPC.tasksResult, id),
        cancel: (id) => ipcRenderer.invoke(IPC.tasksCancel, id),
        retry: (id) => ipcRenderer.invoke(IPC.tasksRetry, id),
        remove: (id) => ipcRenderer.invoke(IPC.tasksRemove, id),
        clearFinished: () => ipcRenderer.invoke(IPC.tasksClearFinished),
        stats: () => ipcRenderer.invoke(IPC.tasksStats),
        syncChannels: (channels) => ipcRenderer.invoke(IPC.tasksSyncChannels, channels),
        getConcurrency: () => ipcRenderer.invoke(IPC.tasksGetConcurrency),
        setConcurrency: (concurrency) => ipcRenderer.invoke(IPC.tasksSetConcurrency, concurrency),
        onChanged: (callback) => {
            ipcRenderer.on(IPC.tasksChanged, (_event, task) => callback(task));
        },
        onDelta: (callback) => {
            ipcRenderer.on(IPC.tasksDelta, (_event, event) => callback(event));
        },
        onOpen: (callback) => {
            ipcRenderer.on(IPC.tasksOpen, (_event, event) => callback(event));
        },
    },
};

contextBridge.exposeInMainWorld("unleashly", bridge);
