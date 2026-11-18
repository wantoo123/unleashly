import { ProviderError, classifyHttpStatus, canceledError, fromUnknownError, readErrorMessage, timeoutError } from "./errors";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 800;
const DEFAULT_RETRY_MAX_MS = 12_000;
const MAX_ERROR_BODY = 64 * 1024;

export type GatewayRequestOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    retries?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
};

export type JsonRequestOptions = GatewayRequestOptions & {
    headers?: Record<string, string>;
    method?: string;
    body?: BodyInit | null;
};

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(canceledError());
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(canceledError());
            },
            { once: true },
        );
    });
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError("Provider request timed out"));
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
    };
}

/** Send a request and return the raw Response after status validation. Retries transient failures. */
export async function gatewayFetch(url: string, init: RequestInit, options: GatewayRequestOptions = {}): Promise<Response> {
    const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    const baseDelay = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const maxDelay = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (options.signal?.aborted) throw canceledError();
        const combined = combinedSignal(options.signal, timeoutMs);
        try {
            const response = await fetch(url, { ...init, signal: combined.signal });
            if (response.ok) return response;
            const text = await readErrorBody(response);
            const { code, retryable } = classifyHttpStatus(response.status);
            const message = readErrorMessage(text) || `Provider request failed with HTTP ${response.status}`;
            lastError = new ProviderError(code, message, { status: response.status, retryable });
            if (!retryable || attempt === retries) throw lastError;
        } catch (error) {
            if (combined.timedOut()) lastError = timeoutError(`Provider request timed out after ${Math.round(timeoutMs / 1000)}s`, error);
            else if (options.signal?.aborted) throw canceledError();
            else if (error instanceof ProviderError) lastError = error;
            else lastError = fromUnknownError(error);
            if (!lastError.retryable || attempt === retries) throw lastError;
        } finally {
            combined.dispose();
        }
        const delay = Math.min(maxDelay, baseDelay * 2 ** attempt) + Math.floor(Math.random() * 250);
        await sleep(delay, options.signal);
    }
    throw lastError || new ProviderError("unknown", "Provider request failed");
}

async function readErrorBody(response: Response) {
    try {
        const text = await response.text();
        return text.slice(0, MAX_ERROR_BODY);
    } catch {
        return "";
    }
}

export async function requestJson<T>(url: string, options: JsonRequestOptions = {}): Promise<T> {
    const { headers, method = "GET", body, ...requestOptions } = options;
    const response = await gatewayFetch(url, { method, headers, body }, requestOptions);
    const text = await response.text();
    if (!text.trim()) return {} as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new ProviderError("invalid_response", `Provider returned a non-JSON response: ${text.slice(0, 160)}`, { status: response.status, retryable: false });
    }
}

export type BinaryResponse = {
    data: Buffer;
    mimeType: string;
    status: number;
};

export async function requestBuffer(url: string, options: JsonRequestOptions = {}): Promise<BinaryResponse> {
    const { headers, method = "GET", body, ...requestOptions } = options;
    const response = await gatewayFetch(url, { method, headers, body }, requestOptions);
    const mimeType = response.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    if (mimeType.includes("json")) {
        const message = readErrorMessage(data.toString("utf8"));
        if (message) throw new ProviderError("invalid_response", message, { status: response.status, retryable: false });
    }
    return { data, mimeType, status: response.status };
}

export async function requestStream(url: string, options: JsonRequestOptions = {}): Promise<Response> {
    const { headers, method = "GET", body, ...requestOptions } = options;
    return gatewayFetch(url, { method, headers, body }, requestOptions);
}

/** Read an SSE response and hand every `data:` payload to the consumer. */
export async function consumeSse(response: Response, onData: (data: string) => void, signal?: AbortSignal) {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = () => {
        for (;;) {
            const match = buffer.match(/\r?\n\r?\n/);
            if (!match) break;
            const index = match.index ?? 0;
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + match[0].length);
            emitBlock(block);
        }
    };
    const emitBlock = (block: string) => {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n")
            .trim();
        if (!data || data === "[DONE]") return;
        onData(data);
    };
    try {
        for (;;) {
            if (signal?.aborted) throw canceledError();
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            flush();
        }
        buffer += decoder.decode();
        if (buffer.trim()) emitBlock(buffer);
    } finally {
        reader.releaseLock();
    }
}

export function apiHeaders(target: { apiKey: string }, contentType?: string) {
    return {
        Authorization: `Bearer ${target.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export function geminiHeaders(target: { apiKey: string }) {
    return {
        "x-goog-api-key": target.apiKey,
        "Content-Type": "application/json",
    };
}

export function apiUrl(baseUrl: string, path: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const withVersion = /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
    return `${withVersion}${path}`;
}

export function geminiBaseUrl(baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    return /\/v1(beta)?$/i.test(normalized) ? normalized : `${normalized}/v1beta`;
}

export function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}
