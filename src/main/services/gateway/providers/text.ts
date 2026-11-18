import type { GatewayTextContent, GatewayTextMessage, TaskUsage, TextTaskRequest } from "@shared/tasks";

import { ProviderError, classifyMessage, readErrorMessage } from "../errors";
import { apiHeaders, apiUrl, consumeSse, geminiBaseUrl, geminiHeaders, geminiModelName, requestStream } from "../http";
import type { ProviderContext, ProviderRunResult } from "../types";

const TEXT_REQUEST_TIMEOUT_MS = 10 * 60_000;

type OpenAiResponsePayload = {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

type GeminiPart = { text?: string; inlineData?: { mimeType?: string; data?: string }; fileData?: { mimeType?: string; fileUri?: string } };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

type ProviderTextMessage = GatewayTextMessage;

function assertTextPayload(payload: { code?: number; msg?: string; error?: { message?: string } }) {
    if (typeof payload.code === "number" && payload.code !== 0) throw classifyMessage(payload.msg || "Provider rejected the text request");
    if (payload.error?.message) throw classifyMessage(payload.error.message);
}

function systemText(request: TextTaskRequest) {
    const parts = [request.systemPrompt?.trim(), ...request.messages.flatMap((message) => (message.role === "system" ? [textOf(message.content)] : []))].filter(Boolean);
    return parts.join("\n\n");
}

function textOf(content: GatewayTextContent[] | string) {
    return typeof content === "string" ? content : content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function responseContent(content: GatewayTextContent[] | string) {
    if (typeof content === "string") return content;
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function responseInput(messages: ProviderTextMessage[], system: string) {
    const input = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: responseContent(message.content) }));
    return system ? [{ role: "system" as const, content: system }, ...input] : input;
}

function geminiParts(content: GatewayTextContent[] | string): GeminiPart[] {
    if (typeof content === "string") return [{ text: content }];
    return content.map((item) => {
        if (item.type === "text") return { text: item.text };
        const match = item.image_url.url.match(/^data:([^;,]+);base64,(.+)$/);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: item.image_url.url, mimeType: "image/png" } };
    });
}

function geminiBody(request: TextTaskRequest) {
    const system = systemText(request);
    const contents = request.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: geminiParts(message.content) }));
    return {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
}

function openAiUrl(baseUrl: string) {
    return apiUrl(baseUrl, "/responses");
}

function geminiUrl(baseUrl: string, model: string) {
    return `${geminiBaseUrl(baseUrl)}/models/${encodeURIComponent(geminiModelName(model))}:streamGenerateContent?alt=sse`;
}

function openAiUsage(payload?: OpenAiResponsePayload): TaskUsage | undefined {
    const usage = payload?.usage;
    if (!usage) return undefined;
    return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
    };
}

function geminiUsage(payload?: GeminiPayload): TaskUsage | undefined {
    const usage = payload?.usageMetadata;
    if (!usage) return undefined;
    return {
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
    };
}

function parseOpenAiText(payload: OpenAiResponsePayload) {
    assertTextPayload(payload);
    const content =
        payload.output_text ||
        (payload.output || [])
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    return content;
}

function parseGeminiText(payload: GeminiPayload) {
    assertTextPayload(payload);
    if (payload.promptFeedback?.blockReason) {
        throw new ProviderError("content_policy", `Gemini rejected the request: ${payload.promptFeedback.blockReason}`, { retryable: false });
    }
    return (payload.candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => part.text || "")
        .join("");
}

async function requestOpenAiText(request: TextTaskRequest, ctx: ProviderContext): Promise<ProviderRunResult> {
    const response = await requestStream(openAiUrl(request.target.baseUrl), {
        method: "POST",
        headers: { ...apiHeaders(request.target, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({
            model: request.target.model,
            input: responseInput(request.messages, systemText(request)),
            stream: true,
            ...(request.reasoningEffort && request.reasoningEffort !== "auto" ? { reasoning: { effort: request.reasoningEffort } } : {}),
        }),
        signal: ctx.signal,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS,
        retries: 2,
    });
    if (!response.body) {
        const payload = (await response.json()) as OpenAiResponsePayload;
        const text = parseOpenAiText(payload);
        ctx.onDelta?.(text);
        ctx.onProgress?.(1, "done");
        return { items: [], text, usage: openAiUsage(payload) };
    }
    let text = "";
    let usage: TaskUsage | undefined;
    let streamError = "";
    await consumeSse(
        response,
        (data) => {
            let event: Record<string, unknown>;
            try {
                event = JSON.parse(data) as Record<string, unknown>;
            } catch {
                throw new ProviderError("invalid_response", "Provider returned an invalid text event", { retryable: false });
            }
            const type = typeof event.type === "string" ? event.type : "";
            const message = readErrorMessage(event);
            if (message) streamError = message;
            if (type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta;
                ctx.onDelta?.(text);
            } else if (type === "response.output_text.done" && typeof event.text === "string") {
                if (!text) {
                    text = event.text;
                    ctx.onDelta?.(text);
                }
            } else if (type === "response.completed" && event.response && typeof event.response === "object") {
                const payload = event.response as OpenAiResponsePayload;
                if (!text) {
                    text = parseOpenAiText(payload);
                    ctx.onDelta?.(text);
                }
                usage = openAiUsage(payload) || usage;
            } else if (Array.isArray(event.output)) {
                const payload = event as OpenAiResponsePayload;
                if (!text) {
                    text = parseOpenAiText(payload);
                    ctx.onDelta?.(text);
                }
                usage = openAiUsage(payload) || usage;
            }
        },
        ctx.signal,
    );
    if (streamError) throw classifyMessage(streamError);
    if (!text.trim()) throw new ProviderError("invalid_response", "Provider did not return any text", { retryable: false });
    ctx.onProgress?.(1, "done");
    return { items: [], text, usage };
}

async function requestGeminiText(request: TextTaskRequest, ctx: ProviderContext): Promise<ProviderRunResult> {
    const response = await requestStream(geminiUrl(request.target.baseUrl, request.target.model), {
        method: "POST",
        headers: { ...geminiHeaders(request.target), Accept: "text/event-stream" },
        body: JSON.stringify(geminiBody(request)),
        signal: ctx.signal,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS,
        retries: 2,
    });
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        const text = parseGeminiText(payload);
        ctx.onDelta?.(text);
        ctx.onProgress?.(1, "done");
        return { items: [], text, usage: geminiUsage(payload) };
    }
    let text = "";
    let usage: TaskUsage | undefined;
    let streamError = "";
    await consumeSse(
        response,
        (data) => {
            let payload: GeminiPayload;
            try {
                payload = JSON.parse(data) as GeminiPayload;
            } catch {
                throw new ProviderError("invalid_response", "Provider returned an invalid text event", { retryable: false });
            }
            const message = readErrorMessage(payload);
            if (message) streamError = message;
            text += parseGeminiText(payload);
            if (text) ctx.onDelta?.(text);
            usage = geminiUsage(payload) || usage;
        },
        ctx.signal,
    );
    if (streamError) throw classifyMessage(streamError);
    if (!text.trim()) throw new ProviderError("invalid_response", "Provider did not return any text", { retryable: false });
    ctx.onProgress?.(1, "done");
    return { items: [], text, usage };
}

export async function runTextProvider(request: TextTaskRequest, ctx: ProviderContext): Promise<ProviderRunResult> {
    ctx.onProgress?.(0.05, "requesting");
    return request.target.apiFormat === "gemini" ? requestGeminiText(request, ctx) : requestOpenAiText(request, ctx);
}

export function textProgressSummary(request: TextTaskRequest) {
    return {
        messages: request.messages.length,
        reasoningEffort: request.reasoningEffort || "auto",
        characters: request.messages.reduce((total, message) => total + textOf(message.content).length, 0),
    };
}
