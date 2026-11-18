import type { ImageTaskRequest } from "@shared/tasks";

import { ProviderError, classifyMessage, readErrorMessage } from "../errors";
import { gatewayFetch, apiHeaders, apiUrl, geminiBaseUrl, geminiHeaders, geminiModelName, requestJson, type GatewayRequestOptions } from "../http";
import { inferMediaScale, normalizeBackground, normalizeQuality, resolveGeminiImageConfig, resolveRequestSize } from "../image-params";
import type { BinaryOutput, ProviderContext, ProviderRunResult, ResolvedInput } from "../types";

const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_OUTPUT_FORMAT = "png";

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    images?: Array<Record<string, unknown>>;
    results?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    thoughtSignature?: string;
};

type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};

function withSystemPrompt(prompt: string, systemPrompt?: string) {
    const system = (systemPrompt || "").trim();
    return system ? `${system}\n\n${prompt}` : prompt;
}

function validateGenerationPayload(payload: { code?: number; msg?: string; error?: { message?: string } }) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw classifyMessage(payload.msg || "Provider rejected the image request");
    }
    if (payload.error?.message) throw classifyMessage(payload.error.message);
}

function parseImagePayload(payload: ImageApiResponse): Array<{ data?: Buffer; url?: string; mimeType: string }> {
    validateGenerationPayload(payload);
    const list = payload.data || payload.images || payload.results || [];
    const images = list.flatMap<{ data?: Buffer; url?: string; mimeType: string }>((item) => {
        if (typeof item.b64_json === "string" && item.b64_json) {
            return [{ data: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" }];
        }
        if (typeof item.url === "string" && item.url) return [{ url: item.url, mimeType: "image/png" }];
        return [];
    });
    if (!images.length) {
        const fields = Object.keys(payload).filter((key) => !["code", "msg", "error"].includes(key));
        throw new ProviderError("invalid_response", fields.length ? `Provider returned an unrecognized image response (fields: ${fields.join(", ")})` : "Provider did not return any image", { retryable: false });
    }
    return images;
}

function parseGeminiImagePayload(payload: GeminiPayload): Array<{ data?: Buffer; url?: string; mimeType: string }> {
    validateGenerationPayload(payload);
    if (payload.promptFeedback?.blockReason) {
        throw new ProviderError("content_policy", `Gemini rejected the request: ${payload.promptFeedback.blockReason}`, { retryable: false });
    }
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .flatMap<{ data?: Buffer; url?: string; mimeType: string }>((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return [{ data: Buffer.from(inlineData.data, "base64"), mimeType: inlineData.mimeType || "image/png" }];
                if (part.fileData?.fileUri) return [{ url: part.fileData.fileUri, mimeType: part.fileData.mimeType || "image/png" }];
                return [];
            }) || [];
    if (!images.length) throw new ProviderError("invalid_response", "Gemini did not return any image", { retryable: false });
    return images;
}

async function downloadImage(url: string, signal: AbortSignal): Promise<BinaryOutput> {
    const response = await gatewayFetch(url, { method: "GET", signal }, { signal, timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS, retries: 2 });
    const mimeType = response.headers.get("content-type") || "image/png";
    return { data: Buffer.from(await response.arrayBuffer()), mimeType };
}

function imageResultOptions(signal: AbortSignal): GatewayRequestOptions {
    return { signal, timeoutMs: IMAGE_REQUEST_TIMEOUT_MS, retries: 1 };
}

async function generateOpenAi(request: ImageTaskRequest, prompt: string, ctx: ProviderContext): Promise<ProviderRunResult> {
    const model = request.target.model;
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.count)) || 1)));
    const quality = normalizeQuality(request.quality);
    const size = resolveRequestSize(request.size);
    const background = normalizeBackground(request.background);
    const payload = await requestJson<ImageApiResponse>(apiUrl(request.target.baseUrl, "/images/generations"), {
        method: "POST",
        headers: apiHeaders(request.target, "application/json"),
        body: JSON.stringify({
            model,
            prompt,
            n: count,
            ...(quality ? { quality } : {}),
            ...(size ? { size } : {}),
            ...(background ? { background } : {}),
            ...(/gpt-image/.test(model) ? {} : { response_format: "b64_json" }),
            output_format: IMAGE_OUTPUT_FORMAT,
        }),
        ...imageResultOptions(ctx.signal),
    });
    const images = parseImagePayload(payload);
    const items: BinaryOutput[] = [];
    for (const [index, image] of images.entries()) {
        items.push(image.data ? { data: image.data, mimeType: image.mimeType } : await downloadImage(image.url!, ctx.signal));
        ctx.onProgress?.(Math.min(1, (index + 1) / Math.max(1, images.length)));
    }
    return { items, usage: { images: items.length } };
}

async function editOpenAi(request: ImageTaskRequest, prompt: string, inputs: ResolvedInput[], ctx: ProviderContext): Promise<ProviderRunResult> {
    const model = request.target.model;
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.count)) || 1)));
    const quality = normalizeQuality(request.quality);
    const size = resolveRequestSize(request.size);
    const background = normalizeBackground(request.background);
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("n", String(count));
    if (!/gpt-image/.test(model)) form.set("response_format", "b64_json");
    form.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) form.set("quality", quality);
    if (size) form.set("size", size);
    if (background) form.set("background", background);
    const imageField = inputs.length > 1 ? "image[]" : "image";
    for (const input of inputs) {
        form.append(imageField, new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.name || `reference-${input.index}.png`);
    }
    const payload = await requestJson<ImageApiResponse>(apiUrl(request.target.baseUrl, "/images/edits"), {
        method: "POST",
        headers: apiHeaders(request.target),
        body: form,
        ...imageResultOptions(ctx.signal),
    });
    const images = parseImagePayload(payload);
    const items: BinaryOutput[] = [];
    for (const [index, image] of images.entries()) {
        items.push(image.data ? { data: image.data, mimeType: image.mimeType } : await downloadImage(image.url!, ctx.signal));
        ctx.onProgress?.(Math.min(1, (index + 1) / Math.max(1, images.length)));
    }
    return { items, usage: { images: items.length } };
}

function geminiImageUrl(baseUrl: string, model: string) {
    return `${geminiBaseUrl(baseUrl)}/models/${encodeURIComponent(geminiModelName(model))}:generateContent`;
}

function toGeminiImagePart(input: ResolvedInput): GeminiPart {
    return { inlineData: { mimeType: input.mimeType, data: input.data.toString("base64") } };
}

async function generateGemini(request: ImageTaskRequest, prompt: string, inputs: ResolvedInput[], ctx: ProviderContext): Promise<ProviderRunResult> {
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.count)) || 1)));
    const parts: GeminiPart[] = [{ text: prompt }, ...inputs.map(toGeminiImagePart)];
    const imageConfig = resolveGeminiImageConfig(request.size);
    const body = {
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...imageConfig },
        ...(request.systemPrompt?.trim() ? { systemInstruction: { parts: [{ text: request.systemPrompt.trim() }] } } : {}),
    };
    const items: BinaryOutput[] = [];
    for (let index = 0; index < count; index += 1) {
        if (ctx.signal.aborted) throw new ProviderError("canceled", "Request canceled", { retryable: false });
        const payload = await requestJson<GeminiPayload>(geminiImageUrl(request.target.baseUrl, request.target.model), {
            method: "POST",
            headers: geminiHeaders(request.target),
            body: JSON.stringify(body),
            ...imageResultOptions(ctx.signal),
        });
        const images = parseGeminiImagePayload(payload);
        for (const image of images) {
            items.push(image.data ? { data: image.data, mimeType: image.mimeType } : await downloadImage(image.url!, ctx.signal));
        }
        ctx.onProgress?.(Math.min(1, (index + 1) / count));
    }
    return { items, usage: { images: items.length } };
}

export async function runImageProvider(request: ImageTaskRequest, inputs: ResolvedInput[], ctx: ProviderContext): Promise<ProviderRunResult> {
    const systemPrompt = request.systemPrompt?.trim();
    const prompt = withSystemPrompt(request.prompt, systemPrompt);
    ctx.onProgress?.(0.05, "requesting");
    if (request.target.apiFormat === "gemini") {
        if (request.operation === "edit" && inputs.length > 0) return generateGemini(request, prompt, inputs, ctx);
        return generateGemini(request, prompt, [], ctx);
    }
    return request.operation === "edit" ? editOpenAi(request, prompt, inputs, ctx) : generateOpenAi(request, prompt, ctx);
}

export function imageProgressSummary(request: ImageTaskRequest) {
    return {
        operation: request.operation,
        count: Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.count)) || 1))),
        size: request.size || "auto",
        quality: request.quality || "auto",
        background: request.background || "",
        resolution: inferMediaScale(request.size),
        references: request.inputs?.length || 0,
    };
}

export function readImageProviderError(error: unknown) {
    return readErrorMessage(error);
}
