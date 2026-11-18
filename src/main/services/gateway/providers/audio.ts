import type { AudioTaskRequest } from "@shared/tasks";

import { ProviderError, classifyMessage, readErrorMessage } from "../errors";
import { apiHeaders, apiUrl, requestBuffer } from "../http";
import type { ProviderContext, ProviderRunResult } from "../types";

const AUDIO_REQUEST_TIMEOUT_MS = 5 * 60_000;

const AUDIO_MIME_TYPES: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    pcm: "audio/pcm",
    m4a: "audio/mp4",
};

function audioMimeType(format: string) {
    return AUDIO_MIME_TYPES[format] || "audio/mpeg";
}

function assertAudioPayload(data: Buffer) {
    const text = data.toString("utf8", 0, Math.min(data.length, 4096));
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(data.toString("utf8")) as typeof payload;
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw classifyMessage(payload.msg || "Audio generation failed");
    if (payload.error?.message) throw classifyMessage(payload.error.message);
}

export async function runAudioProvider(request: AudioTaskRequest, ctx: ProviderContext): Promise<ProviderRunResult> {
    if (request.target.apiFormat === "gemini") {
        throw new ProviderError("unsupported", "Gemini audio generation is not supported; use an OpenAI-compatible channel", { retryable: false });
    }
    const instructions = request.instructions?.trim() || "";
    ctx.onProgress?.(0.05, "requesting");
    const response = await requestBuffer(apiUrl(request.target.baseUrl, "/audio/speech"), {
        method: "POST",
        headers: apiHeaders(request.target, "application/json"),
        body: JSON.stringify({
            model: request.target.model,
            input: request.prompt,
            voice: request.voice || "alloy",
            response_format: request.format || "mp3",
            speed: Number(request.speed) || 1,
            ...(instructions ? { instructions } : {}),
        }),
        signal: ctx.signal,
        timeoutMs: AUDIO_REQUEST_TIMEOUT_MS,
        retries: 1,
    });
    assertAudioPayload(response.data);
    const mimeType = response.mimeType.startsWith("audio/") ? response.mimeType : audioMimeType(request.format);
    ctx.onProgress?.(1, "done");
    return {
        items: [{ data: response.data, mimeType }],
        usage: { characters: request.prompt.length, audioSeconds: 0 },
    };
}

export function audioProgressSummary(request: AudioTaskRequest) {
    return {
        voice: request.voice,
        format: request.format,
        speed: request.speed,
        instructions: request.instructions ? "custom" : "",
        characters: request.prompt.length,
    };
}

export function readAudioProviderError(error: unknown) {
    return readErrorMessage(error);
}
