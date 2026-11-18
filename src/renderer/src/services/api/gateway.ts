import type { EnqueueTaskRequest, GatewayTextMessage, ImageTaskRequest, ProviderTarget, TaskInput, TaskRecord, TaskResultPayload, TextTaskRequest, VideoTaskRequest } from "@shared/tasks";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, decodeChannelModel, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { getTaskBridge, isTaskGatewayAvailable } from "@/platform/tasks";
import { subscribeTaskChanges, subscribeTaskDeltas } from "@/platform/task-events";

export type GatewayImageResult = { id: string; dataUrl: string };
export type GatewayVideoResult = { blob?: Blob; url?: string; mimeType?: string };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

type WaitOptions = {
    signal?: AbortSignal;
    onProgress?: (task: TaskRecord) => void;
    onDelta?: (text: string) => void;
};

export function gatewayTarget(config: AiConfig, modelValue: string): ProviderTarget {
    const resolved = resolveModelRequestConfig(config, modelValue);
    const decoded = decodeChannelModel(modelValue);
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === modelOptionName(modelValue)));
    return {
        channelId: channel?.id || decoded?.channelId || "default",
        channelName: channel?.name,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        apiFormat: resolved.apiFormat,
        model: resolved.model,
    };
}

function abortError() {
    return new DOMException("Aborted", "AbortError");
}

function taskError(task: TaskRecord) {
    const error = task.error;
    const message = localizeTaskError(task);
    const result = new Error(message);
    if (task.kind === "video" && task.status === "failed") result.name = "VideoTaskFailed";
    if (error?.code === "canceled") return abortError();
    return result;
}

function localizeTaskError(task: TaskRecord) {
    const error = task.error;
    if (!error) return i18n.t("apiErrors.requestFailed");
    switch (error.code) {
        case "auth":
            return i18n.t("apiErrors.authenticationFailed");
        case "rate_limit":
            return i18n.t("apiErrors.rateLimited");
        case "timeout":
            return task.kind === "video" ? i18n.t("apiErrors.videoTimeout", { provider: "" }) : i18n.t("apiErrors.imageTimeout");
        case "network":
            return i18n.t("apiErrors.requestFailed");
        case "server":
            return i18n.t("apiErrors.serviceBusy");
        case "not_found":
            return i18n.t("apiErrors.notFound");
        case "interrupted":
            return i18n.t("tasks.interrupted");
        case "unsupported":
            return i18n.t("tasks.unsupported");
        case "config":
            return error.message || i18n.t("workbench.configFirst");
        case "content_policy":
        case "invalid_request":
        case "invalid_response":
        case "unknown":
        default:
            return error.message || i18n.t("apiErrors.requestFailed");
    }
}

async function waitForTask(taskId: string, options: WaitOptions = {}): Promise<{ task: TaskRecord; result: TaskResultPayload | null }> {
    const bridge = getTaskBridge();
    if (!bridge) throw new Error(i18n.t("tasks.unavailable"));
    if (options.signal?.aborted) {
        await bridge.cancel(taskId).catch(() => undefined);
        throw abortError();
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let interval: number | undefined;
        let unsubscribeChanges: (() => void) | undefined;
        let unsubscribeDeltas: (() => void) | undefined;

        const cleanup = () => {
            if (interval !== undefined) window.clearInterval(interval);
            unsubscribeChanges?.();
            unsubscribeDeltas?.();
            options.signal?.removeEventListener("abort", handleAbort);
        };

        const finish = async (task: TaskRecord) => {
            if (settled) return;
            if (task.status === "queued" || task.status === "running") return;
            settled = true;
            cleanup();
            if (task.status === "succeeded") {
                try {
                    const result = await bridge.result(task.id);
                    resolve({ task, result });
                } catch (error) {
                    reject(error);
                }
                return;
            }
            reject(taskError(task));
        };

        const handleAbort = () => {
            if (settled) return;
            void bridge.cancel(taskId).catch(() => undefined);
            settled = true;
            cleanup();
            reject(abortError());
        };

        options.signal?.addEventListener("abort", handleAbort, { once: true });

        unsubscribeChanges = subscribeTaskChanges((task) => {
            if (task.id !== taskId) return;
            options.onProgress?.(task);
            void finish(task);
        });
        unsubscribeDeltas = subscribeTaskDeltas((event) => {
            if (event.taskId === taskId) options.onDelta?.(event.text);
        });

        const check = async () => {
            if (settled) return;
            try {
                const task = await bridge.get(taskId);
                if (!task) {
                    settled = true;
                    cleanup();
                    reject(new Error(i18n.t("tasks.notFound")));
                    return;
                }
                options.onProgress?.(task);
                await finish(task);
            } catch (error) {
                settled = true;
                cleanup();
                reject(error);
            }
        };

        void check();
        interval = window.setInterval(() => void check(), 2000);
    });
}

async function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}

async function imageInputs(references: ReferenceImage[], signal?: AbortSignal): Promise<TaskInput[]> {
    return Promise.all(
        references.map(async (image, index) => {
            const dataUrl = await imageToDataUrl(image, { signal });
            if (!dataUrl) throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));
            return { kind: "image" as const, name: image.name || `reference-${index + 1}.png`, mimeType: image.type || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png", dataUrl };
        }),
    );
}

async function mediaInputs(items: Array<ReferenceVideo | ReferenceAudio>, kind: "video" | "audio", signal?: AbortSignal): Promise<TaskInput[]> {
    return Promise.all(
        items.map(async (item, index) => {
            let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
            if (!blob) {
                const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
                if (!url) throw new Error(i18n.t(kind === "video" ? "apiErrors.invalidReferenceVideo" : "apiErrors.invalidReferenceAudio"));
                try {
                    blob = await (await fetch(url, { signal })).blob();
                } catch (error) {
                    if (signal?.aborted) throw abortError();
                    throw new Error(i18n.t(kind === "video" ? "apiErrors.invalidReferenceVideo" : "apiErrors.invalidReferenceAudio"));
                }
            }
            if (!blob.size) throw new Error(i18n.t(kind === "video" ? "apiErrors.invalidReferenceVideo" : "apiErrors.invalidReferenceAudio"));
            return {
                kind,
                name: item.name || `reference-${index + 1}.${kind === "video" ? "mp4" : "mp3"}`,
                mimeType: item.type || blob.type || (kind === "video" ? "video/mp4" : "audio/mpeg"),
                dataUrl: await blobToDataUrl(blob),
            };
        }),
    );
}

async function enqueue(request: EnqueueTaskRequest) {
    const bridge = getTaskBridge();
    if (!bridge) throw new Error(i18n.t("tasks.unavailable"));
    return bridge.enqueue(request);
}

function imageRequest(config: AiConfig, modelValue: string, prompt: string, operation: "generate" | "edit", inputs: TaskInput[]): ImageTaskRequest {
    return {
        kind: "image",
        target: gatewayTarget(config, modelValue),
        prompt,
        systemPrompt: config.systemPrompt,
        operation,
        count: Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1))),
        size: config.size,
        quality: config.quality,
        background: config.background,
        inputs,
    };
}

export async function runGatewayImageTask(config: AiConfig, prompt: string, options: { model: string; operation: "generate" | "edit"; references?: ReferenceImage[]; signal?: AbortSignal }) {
    const references = options.references || [];
    const inputs = references.length ? await imageInputs(references, options.signal) : [];
    const request = imageRequest(config, options.model, prompt, options.operation, inputs);
    const task = await enqueue({ request, origin: "image-gateway", maxAttempts: 1 });
    const { result } = await waitForTask(task.id, { signal: options.signal });
    const images = (result?.items || []).filter((item) => item.dataUrl).map((item) => ({ id: nanoid(), dataUrl: item.dataUrl as string }));
    if (!images.length) throw new Error(i18n.t("apiErrors.noImageReturned"));
    return images;
}

export async function runGatewayAudioTask(config: AiConfig, prompt: string, options: { model: string; signal?: AbortSignal }) {
    const request = {
        kind: "audio" as const,
        target: gatewayTarget(config, options.model),
        prompt,
        voice: config.audioVoice,
        format: config.audioFormat,
        speed: config.audioSpeed,
        instructions: config.audioInstructions,
    };
    const task = await enqueue({ request, origin: "audio-gateway", maxAttempts: 2 });
    const { result } = await waitForTask(task.id, { signal: options.signal });
    const item = result?.items.find((entry) => entry.data);
    if (!item?.data) throw new Error(i18n.t("apiErrors.scriptNoAudio"));
    return new Blob([item.data], { type: item.mimeType || "audio/mpeg" });
}

export async function runGatewayTextTask(config: AiConfig, messages: ChatMessage[], model: string, onDelta?: (text: string) => void, options: { signal?: AbortSignal } = {}) {
    const request: TextTaskRequest = {
        kind: "text",
        target: gatewayTarget(config, model),
        messages: messages as GatewayTextMessage[],
        systemPrompt: config.systemPrompt,
        reasoningEffort: config.reasoningEffort,
    };
    const task = await enqueue({ request, origin: "text-gateway", hidden: true, maxAttempts: 2 });
    const { result } = await waitForTask(task.id, { signal: options.signal, onDelta });
    const text = String(result?.text ?? "").trim();
    if (!text) throw new Error(i18n.t("apiErrors.noContent"));
    return text;
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

export async function createGatewayVideoTask(config: AiConfig, modelValue: string, prompt: string, references: ReferenceImage[] = [], options: { signal?: AbortSignal; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] } = {}) {
    const images = await imageInputs(references, options.signal);
    const videos = await mediaInputs(options.videos || [], "video", options.signal);
    const audios = await mediaInputs(options.audios || [], "audio", options.signal);
    const request: VideoTaskRequest = {
        kind: "video",
        target: gatewayTarget(config, modelValue),
        prompt,
        seconds: config.videoSeconds,
        size: config.size,
        resolution: config.vquality,
        generateAudio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
        mode: resolveVideoMode(config.videoMode, images.length),
        inputs: [...images, ...videos, ...audios],
    };
    return enqueue({ request, origin: "video-gateway", maxAttempts: 2 });
}

function videoResult(payload: TaskResultPayload | null): GatewayVideoResult {
    const item = payload?.items.find((entry) => entry.data || entry.url);
    if (!item) throw new Error(i18n.t("apiErrors.noPlayableVideo"));
    if (item.data) return { blob: new Blob([item.data], { type: item.mimeType || "video/mp4" }), mimeType: item.mimeType || "video/mp4" };
    return { url: item.url, mimeType: item.mimeType || "video/mp4" };
}

export async function pollGatewayVideoTask(taskId: string, options: WaitOptions = {}): Promise<{ status: "pending" } | { status: "completed"; result: GatewayVideoResult } | { status: "failed"; error: string }> {
    const bridge = getTaskBridge();
    if (!bridge) return { status: "pending" };
    const task = await bridge.get(taskId);
    if (!task) return { status: "failed", error: i18n.t("tasks.notFound") };
    options.onProgress?.(task);
    if (task.status === "queued" || task.status === "running") return { status: "pending" };
    if (task.status === "canceled") throw abortError();
    if (task.status === "failed") return { status: "failed", error: localizeTaskError(task) };
    const payload = await bridge.result(taskId);
    return { status: "completed", result: videoResult(payload) };
}

export async function waitGatewayVideoTask(taskId: string, options: WaitOptions = {}): Promise<GatewayVideoResult> {
    const { result } = await waitForTask(taskId, options);
    return videoResult(result);
}

export function isGatewayAvailable() {
    return isTaskGatewayAvailable();
}

export function isGatewayTaskId(value: string | undefined | null) {
    return typeof value === "string" && value.startsWith("task_");
}
