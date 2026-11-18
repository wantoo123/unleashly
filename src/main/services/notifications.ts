import { BrowserWindow, Notification } from "electron";

import type { TaskRecord } from "@shared/tasks";

import { log } from "./logger";

const KIND_LABELS: Record<TaskRecord["kind"], string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    text: "文本",
    model3d: "3D",
};

function formatDuration(startedAt?: number, finishedAt?: number) {
    if (!startedAt || !finishedAt) return "";
    const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function notifyTaskFinished(task: TaskRecord, getWindow: () => BrowserWindow | null, openTask: (taskId: string) => void) {
    if (task.hidden || task.status === "canceled") return;
    if (!Notification.isSupported()) return;
    const window = getWindow();
    // Foreground users already see the result in the UI; only notify for background work.
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) return;
    const label = KIND_LABELS[task.kind] || "任务";
    const succeeded = task.status === "succeeded";
    const duration = formatDuration(task.startedAt, task.finishedAt);
    const title = succeeded ? `${label}生成完成` : `${label}生成失败`;
    const body = succeeded ? [task.title, duration].filter(Boolean).join(" · ") : task.error?.message || task.title;
    try {
        const notification = new Notification({ title, body, silent: false });
        notification.on("click", () => openTask(task.id));
        notification.show();
    } catch (error) {
        log.warn("Failed to show task notification", error);
    }
}
