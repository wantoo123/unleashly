import { app, BrowserWindow, Notification } from "electron";
import { join } from "node:path";

import { IPC } from "@shared/ipc";
import type { TaskDeltaEvent, TaskRecord } from "@shared/tasks";

import { log } from "./logger";
import { notifyTaskFinished } from "./notifications";
import { TaskQueue } from "./gateway/queue";
import { updateTrayTasks } from "./tray";

type TaskServiceOptions = {
    getWindow: () => BrowserWindow | null;
};

let queue: TaskQueue | null = null;
let options: TaskServiceOptions | null = null;

function broadcast(channel: string, payload: unknown) {
    const window = options?.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, payload);
}

function refreshTray() {
    if (!queue) return;
    const active = queue.list({ status: "active", includeHidden: true });
    updateTrayTasks(active.filter((task) => task.status === "running").length, active.filter((task) => task.status === "queued").length);
}

export async function initTaskService(nextOptions: TaskServiceOptions) {
    if (queue) return queue;
    options = nextOptions;
    queue = new TaskQueue({
        dir: join(app.getPath("userData"), "tasks"),
        log,
        onChanged: (task: TaskRecord) => {
            broadcast(IPC.tasksChanged, task);
            refreshTray();
        },
        onDelta: (event: TaskDeltaEvent) => broadcast(IPC.tasksDelta, event),
        onFinished: (task: TaskRecord) => {
            refreshTray();
            notifyTaskFinished(task, () => options?.getWindow() ?? null, showTaskCenter);
        },
        onActiveCountChanged: () => refreshTray(),
    });
    await queue.init();
    refreshTray();
    log.info("Task service initialized", { tasks: queue.list({ status: "all", includeHidden: true }).length });
    return queue;
}

export function getTaskQueue() {
    if (!queue) throw new Error("Task service is not initialized");
    return queue;
}

export function getTaskQueueIfReady() {
    return queue;
}

export function showTaskCenter(taskId?: string) {
    const window = options?.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    const send = () => {
        if (!window.webContents.isDestroyed()) window.webContents.send(IPC.tasksOpen, { taskId });
    };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
}

/** Notify the user that generation continues in the tray when the window is closed. */
export function notifyBackgroundGeneration() {
    if (!queue || !Notification.isSupported()) return;
    const active = queue.list({ status: "active", includeHidden: true });
    if (!active.length) return;
    try {
        new Notification({
            title: "Unleashly 仍在后台生成",
            body: `${active.length} 个任务正在后台运行，可从托盘重新打开窗口。`,
            silent: true,
        }).show();
    } catch (error) {
        log.warn("Failed to show background generation notification", error);
    }
}

export function hasActiveTasks() {
    return queue?.hasActiveTasks() ?? false;
}

export async function shutdownTaskService() {
    if (!queue) return;
    await queue.shutdown();
    queue = null;
    options = null;
}
