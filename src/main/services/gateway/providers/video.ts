import type { VideoTaskRequest } from "@shared/tasks";

import { ProviderError, canceledError, readErrorMessage } from "../errors";
import { apiHeaders, apiUrl, gatewayFetch, geminiBaseUrl, geminiHeaders, geminiModelName, requestJson } from "../http";
import type { BinaryOutput, ProviderContext, ProviderRunResult, ResolvedInput } from "../types";

const VIDEO_CREATE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_POLL_TIMEOUT_MS = 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 2500;
const VIDEO_MAX_POLLS = 720;

type VideoResponse = {
    id: string;
    status?: string;
    error?: { message?: string };
    url?: string;
    result_url?: string;
    video_url?: string;
    content?: { video_url?: string; url?: string } | null;
};

type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };

type GeminiInlineData = { bytesBase64Encoded: string; mimeType: string };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new ProviderError("invalid_response", emptyMessage, { retryable: false });
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new ProviderError("invalid_request", readErrorMessage(payload) || "Provider rejected the request", { retryable: false });
        if (!payload.data) throw new ProviderError("invalid_response", emptyMessage, { retryable: false });
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (/^https?:\/\//i.test(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function geminiVideoUrl(baseUrl: string, model: string, action: string) {
    return `${geminiBaseUrl(baseUrl)}/models/${encodeURIComponent(geminiModelName(model))}:${action}`;
}

function geminiOperationUrl(baseUrl: string, name: string) {
    return `${geminiBaseUrl(baseUrl)}/${name.replace(/^\//, "")}`;
}

function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { bytesBase64Encoded: match?.[2] || "", mimeType: match?.[1] || fallbackType };
}

function inputInline(input: ResolvedInput): GeminiInlineData {
    return { bytesBase64Encoded: input.data.toString("base64"), mimeType: input.mimeType };
}

function imageInline(input: ResolvedInput): GeminiInlineData {
    return { bytesBase64Encoded: input.data.toString("base64"), mimeType: input.mimeType || "image/png" };
}

function normalizeVideoResolution(value: string | undefined) {
    const raw = (value || "").trim().toLowerCase();
    if (raw === "low") return "480p";
    if (!raw || raw === "auto" || raw === "high" || raw === "medium") return "720p";
    const number = raw.replace(/p$/i, "");
    return /^\d+$/.test(number) && Number(number) > 0 ? `${number}p` : "720p";
}

function parsePixelSize(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function inferVideoRatio(size: string) {
    const value = (size || "").trim();
    if (!value || value === "auto") return "auto";
    const ratios = [
        { value: "1:1", width: 1, height: 1 },
        { value: "3:4", width: 3, height: 4 },
        { value: "4:3", width: 4, height: 3 },
        { value: "16:9", width: 16, height: 9 },
        { value: "9:16", width: 9, height: 16 },
        { value: "21:9", width: 21, height: 9 },
    ];
    if (ratios.some((item) => item.value === value)) return value;
    const pixels = parsePixelSize(value);
    if (!pixels) return "16:9";
    const target = pixels.width / pixels.height;
    return ratios.reduce((best, item) => {
        const current = item.width / item.height;
        const bestOption = ratios.find((option) => option.value === best) || ratios[3];
        const bestRatio = bestOption.width / bestOption.height;
        return Math.abs(current - target) < Math.abs(bestRatio - target) ? item.value : best;
    }, "16:9");
}

export function videoAspectRatio(size: string | undefined) {
    const ratio = inferVideoRatio(size || "16:9");
    return ratio === "auto" ? "16:9" : ratio;
}

export function normalizeVideoSize(size: string | undefined, resolution: string | undefined) {
    const value = (size || "").trim();
    if (value === "auto" || !value) return undefined;
    if (/^\d+x\d+$/.test(value)) return value;
    const ratio = inferVideoRatio(value);
    if (ratio === "auto") return undefined;
    const parsed = ratio.split(":").map(Number);
    const p = Math.max(1, Math.floor(Number(normalizeVideoResolution(resolution).replace(/p$/i, "")) || 720));
    const landscape = parsed[0] >= parsed[1];
    const width = evenRound(landscape ? (p * parsed[0]) / parsed[1] : p);
    const height = evenRound(landscape ? p : (p * parsed[1]) / parsed[0]);
    return `${width}x${height}`;
}

function evenRound(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

function normalizeVideoSeconds(value: string | undefined) {
    const parsed = Math.floor(Number(value) || 6);
    return String(Math.max(4, Math.min(30, parsed)));
}

function videoParams(request: VideoTaskRequest) {
    return {
        seconds: normalizeVideoSeconds(request.seconds),
        size: normalizeVideoSize(request.size, request.resolution),
        resolution: normalizeVideoResolution(request.resolution),
        ratio: videoAspectRatio(request.size),
        mode: request.mode,
    };
}

function videoInputs(inputs: ResolvedInput[]) {
    return {
        images: inputs.filter((input) => input.kind === "image"),
        videos: inputs.filter((input) => input.kind === "video"),
        audios: inputs.filter((input) => input.kind === "audio"),
    };
}

async function createOpenAiVideoTask(request: VideoTaskRequest, inputs: ResolvedInput[], ctx: ProviderContext) {
    const params = videoParams(request);
    const { images, videos, audios } = videoInputs(inputs);
    const body = new FormData();
    body.append("model", request.target.model);
    body.append("prompt", request.prompt);
    body.append("seconds", params.seconds);
    body.append("size", params.size || "1280x720");
    if (params.ratio && params.ratio !== "auto") body.append("ratio", params.ratio);
    body.append("resolution_name", params.resolution);
    body.append("generate_audio", String(request.generateAudio));
    body.append("watermark", String(request.watermark));
    body.append("mode", request.mode);
    if (request.mode === "frames") {
        if (images[0]) {
            body.append("first_frame", new Blob([new Uint8Array(images[0].data)], { type: images[0].mimeType }), "first.png");
            body.append("images", new Blob([new Uint8Array(images[0].data)], { type: images[0].mimeType }), "first.png");
        }
        if (images[1]) {
            body.append("last_frame", new Blob([new Uint8Array(images[1].data)], { type: images[1].mimeType }), "last.png");
            body.append("images", new Blob([new Uint8Array(images[1].data)], { type: images[1].mimeType }), "last.png");
        }
    } else {
        images.forEach((input, index) => {
            const blob = new Blob([new Uint8Array(input.data)], { type: input.mimeType });
            body.append("image[]", blob, `ref_${index + 1}.png`);
            body.append("images", blob, `ref_${index + 1}.png`);
        });
    }
    videos.forEach((input, index) => body.append("video[]", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.name || `ref_${index + 1}.mp4`));
    audios.forEach((input, index) => body.append("audio[]", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.name || `ref_${index + 1}.mp3`));
    const payload = await requestJson<ApiVideoResponse>(apiUrl(request.target.baseUrl, "/videos"), {
        method: "POST",
        headers: apiHeaders(request.target),
        body,
        signal: ctx.signal,
        timeoutMs: VIDEO_CREATE_TIMEOUT_MS,
        retries: 1,
    });
    const created = unwrapEnvelope(payload, "Provider did not return a video task");
    if (!created.id) throw new ProviderError("invalid_response", "Provider did not return a video task id", { retryable: false });
    return { provider: "openai" as const, id: created.id };
}

async function pollOpenAiVideoTask(request: VideoTaskRequest, remoteId: string, ctx: ProviderContext): Promise<{ status: "pending" } | { status: "completed"; item: BinaryOutput } | { status: "failed"; error: string }> {
    const payload = await requestJson<ApiVideoResponse>(apiUrl(request.target.baseUrl, `/videos/${encodeURIComponent(remoteId)}`), {
        headers: apiHeaders(request.target),
        signal: ctx.signal,
        timeoutMs: VIDEO_POLL_TIMEOUT_MS,
        retries: 3,
    });
    const video = unwrapEnvelope(payload, "Provider did not return a video task");
    const url = videoResultUrl(video);
    if (url) return { status: "completed", item: await videoResultFromUrl(url, ctx.signal) };
    if (video.status === "completed") {
        const response = await gatewayFetch(
            apiUrl(request.target.baseUrl, `/videos/${encodeURIComponent(remoteId)}/content`),
            { headers: apiHeaders(request.target), signal: ctx.signal },
            { signal: ctx.signal, timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS, retries: 2 },
        );
        const mimeType = response.headers.get("content-type") || "video/mp4";
        const data = Buffer.from(await response.arrayBuffer());
        if (mimeType.includes("json")) throw new ProviderError("invalid_response", readErrorMessage(data.toString("utf8")) || "Video download failed", { retryable: false });
        return { status: "completed", item: { data, mimeType } };
    }
    if (video.status === "failed" || video.status === "cancelled") {
        return { status: "failed", error: readErrorMessage(video.error?.message) || "Video generation failed" };
    }
    return { status: "pending" };
}

function sanitizeMediaUrl(value: string) {
    try {
        const url = new URL(value);
        for (const key of ["key", "api_key", "apikey", "token", "access_token"]) url.searchParams.delete(key);
        return url.toString();
    } catch {
        return value;
    }
}

async function videoResultFromUrl(url: string, signal: AbortSignal): Promise<BinaryOutput> {
    try {
        const response = await gatewayFetch(url, { signal }, { signal, timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS, retries: 2 });
        const mimeType = response.headers.get("content-type") || "video/mp4";
        return { data: Buffer.from(await response.arrayBuffer()), mimeType };
    } catch (error) {
        if (signal.aborted || (error instanceof ProviderError && error.code === "canceled")) throw canceledError();
        // Falls back to a URL for the renderer to retry. Strip query credentials
        // so they are never persisted in tasks.json.
        return { url: sanitizeMediaUrl(url), mimeType: "video/mp4" };
    }
}

async function createGeminiVideoTask(request: VideoTaskRequest, inputs: ResolvedInput[], ctx: ProviderContext) {
    const params = videoParams(request);
    const { images, videos, audios } = videoInputs(inputs);
    const instance: Record<string, unknown> = { prompt: request.prompt };
    if (request.mode === "frames") {
        if (images[0]) instance.image = imageInline(images[0]);
        if (images[1]) instance.lastFrame = imageInline(images[1]);
    } else {
        instance.referenceImages = images.map((input) => ({ image: imageInline(input), referenceType: "asset" }));
    }
    if (videos[0]) instance.video = inputInline(videos[0]);
    if (audios[0]) instance.audio = inputInline(audios[0]);
    const payload = await requestJson<ApiEnvelope<GeminiVideoOperation>>(geminiVideoUrl(request.target.baseUrl, request.target.model, "predictLongRunning"), {
        method: "POST",
        headers: geminiHeaders(request.target),
        body: JSON.stringify({
            instances: [instance],
            parameters: {
                aspectRatio: params.ratio,
                durationSeconds: Number(params.seconds) || 8,
                resolution: params.resolution,
                generateAudio: request.generateAudio,
                addWatermark: request.watermark,
            },
        }),
        signal: ctx.signal,
        timeoutMs: VIDEO_CREATE_TIMEOUT_MS,
        retries: 1,
    });
    const created = unwrapEnvelope(payload, "Provider did not return a video task");
    if (!created.name) throw new ProviderError("invalid_response", "Provider did not return a video task id", { retryable: false });
    return { provider: "gemini" as const, id: created.name };
}

async function pollGeminiVideoTask(request: VideoTaskRequest, remoteId: string, ctx: ProviderContext): Promise<{ status: "pending" } | { status: "completed"; item: BinaryOutput } | { status: "failed"; error: string }> {
    const payload = await requestJson<ApiEnvelope<GeminiVideoOperation>>(geminiOperationUrl(request.target.baseUrl, remoteId), {
        headers: geminiHeaders(request.target),
        signal: ctx.signal,
        timeoutMs: VIDEO_POLL_TIMEOUT_MS,
        retries: 3,
    });
    const state = unwrapEnvelope(payload, "Video task query failed");
    if (state.error) return { status: "failed", error: readErrorMessage(state.error.message) || "Video generation failed" };
    if (!state.done) return { status: "pending" };
    const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) return { status: "failed", error: "Provider did not return a playable video" };
    const url = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${request.target.apiKey}`;
    return { status: "completed", item: await videoResultFromUrl(url, ctx.signal) };
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(canceledError());
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(canceledError());
            },
            { once: true },
        );
    });
}

function isRetryablePollError(error: unknown) {
    return error instanceof ProviderError && error.retryable;
}

export async function runVideoProvider(request: VideoTaskRequest, inputs: ResolvedInput[], ctx: ProviderContext): Promise<ProviderRunResult> {
    let remote = ctx.remote;
    if (!remote) {
        ctx.onProgress?.(0.03, "creating");
        const created = request.target.apiFormat === "gemini" ? await createGeminiVideoTask(request, inputs, ctx) : await createOpenAiVideoTask(request, inputs, ctx);
        remote = { ...created, model: request.target.model };
        ctx.onRemote?.(remote);
    }
    const activeRemote = remote;
    ctx.onProgress?.(0.08, "polling");
    let consecutiveErrors = 0;
    for (let poll = 0; poll < VIDEO_MAX_POLLS; poll += 1) {
        if (ctx.signal.aborted) throw canceledError();
        let state: { status: "pending" } | { status: "completed"; item: BinaryOutput } | { status: "failed"; error: string };
        try {
            state = activeRemote.provider === "gemini" ? await pollGeminiVideoTask(request, activeRemote.id, ctx) : await pollOpenAiVideoTask(request, activeRemote.id, ctx);
            consecutiveErrors = 0;
        } catch (error) {
            if (!isRetryablePollError(error) || consecutiveErrors >= 4) throw error;
            consecutiveErrors += 1;
            state = { status: "pending" };
        }
        if (state.status === "completed") {
            ctx.onProgress?.(0.95, "downloading");
            return { items: [state.item], usage: { videoSeconds: Number(normalizeVideoSeconds(request.seconds)) } };
        }
        if (state.status === "failed") throw new ProviderError("invalid_request", state.error, { retryable: false });
        ctx.onProgress?.(Math.min(0.9, 0.08 + (poll / 120) * 0.82), "polling");
        await delay(VIDEO_POLL_INTERVAL_MS, ctx.signal);
    }
    throw new ProviderError("timeout", "Video generation timed out after 30 minutes", { retryable: false });
}

export function videoProgressSummary(request: VideoTaskRequest) {
    const params = videoParams(request);
    return {
        seconds: params.seconds,
        size: params.size || "auto",
        resolution: params.resolution,
        ratio: params.ratio,
        mode: request.mode,
        generateAudio: request.generateAudio,
        watermark: request.watermark,
        references: request.inputs?.length || 0,
    };
}
