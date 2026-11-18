import type { TaskErrorCode, TaskErrorInfo } from "@shared/tasks";

/**
 * A normalized provider failure. Every network call in the gateway funnels into this
 * shape so the task queue can decide whether an attempt is retryable and the UI can
 * translate a stable code instead of parsing provider text.
 */
export class ProviderError extends Error {
    readonly code: TaskErrorCode;
    readonly status?: number;
    readonly retryable: boolean;
    readonly details?: unknown;

    constructor(code: TaskErrorCode, message: string, options: { status?: number; retryable?: boolean; details?: unknown } = {}) {
        super(message);
        this.name = "ProviderError";
        this.code = code;
        this.status = options.status;
        this.retryable = options.retryable ?? defaultRetryable(code);
        this.details = options.details;
    }
}

export function defaultRetryable(code: TaskErrorCode) {
    return code === "rate_limit" || code === "timeout" || code === "network" || code === "server";
}

export function providerError(code: TaskErrorCode, message: string, options?: { status?: number; retryable?: boolean; details?: unknown }) {
    return new ProviderError(code, message, options);
}

export function isAbortError(error: unknown) {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function isCanceled(error: unknown) {
    return error instanceof ProviderError && error.code === "canceled";
}

export function canceledError(message = "Request canceled") {
    return new ProviderError("canceled", message, { retryable: false });
}

export function timeoutError(message = "Request timed out", details?: unknown) {
    return new ProviderError("timeout", message, { retryable: true, details });
}

export function classifyHttpStatus(status: number): { code: TaskErrorCode; retryable: boolean } {
    if (status === 401 || status === 403) return { code: "auth", retryable: false };
    if (status === 404) return { code: "not_found", retryable: false };
    if (status === 408) return { code: "timeout", retryable: true };
    if (status === 429) return { code: "rate_limit", retryable: true };
    if (status === 400 || status === 413 || status === 415 || status === 422) return { code: "invalid_request", retryable: false };
    if (status === 409 || status === 425) return { code: "server", retryable: true };
    if (status >= 500) return { code: "server", retryable: status === 500 || status === 502 || status === 503 || status === 504 };
    return { code: "unknown", retryable: false };
}

/** Read an error message from the many shapes providers use. */
export function readErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return "";
        try {
            const parsed = JSON.parse(trimmed);
            const inner = readErrorMessage(parsed);
            if (inner && !(typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 0)) return inner;
        } catch {
            // Not JSON.
        }
        if (/<[a-z][\s\S]*>/i.test(trimmed)) return `Provider returned an HTML error page: ${trimmed.slice(0, 120)}...`;
        return trimmed;
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown; details?: unknown; response?: unknown };
    const errorValue = payload.error;
    const errorMessage = typeof errorValue === "string" ? errorValue : errorValue && typeof errorValue === "object" ? (errorValue as { message?: unknown }).message : undefined;
    const responseValue = payload.response;
    const responseMessage = responseValue && typeof responseValue === "object" ? (responseValue as { error?: unknown }).error : undefined;
    return readErrorMessage(payload.msg) || readErrorMessage(payload.message) || readErrorMessage(errorMessage) || readErrorMessage(payload.detail) || readErrorMessage(payload.details) || readErrorMessage(responseMessage);
}

/** Detect content-policy failures so the queue does not retry them. */
export function isContentPolicyMessage(message: string) {
    return /content[_ ]?policy|safety|moderation|blocked|violat|responsible ai|sensitive content|审核|违规|敏感/i.test(message);
}

export function classifyMessage(message: string, status?: number): ProviderError {
    const trimmed = readErrorMessage(message) || "Provider request failed";
    if (isContentPolicyMessage(trimmed)) return new ProviderError("content_policy", trimmed, { status, retryable: false });
    if (status) {
        const { code, retryable } = classifyHttpStatus(status);
        return new ProviderError(code, trimmed, { status, retryable });
    }
    return new ProviderError("invalid_request", trimmed, { retryable: false });
}

export function fromUnknownError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    if (isAbortError(error)) return new ProviderError("canceled", "Request canceled", { retryable: false });
    if (error instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)) {
        return new ProviderError("network", error.message, { retryable: true });
    }
    if (error instanceof Error) {
        if (/timeout|timed out|ETIMEDOUT/i.test(error.message)) return new ProviderError("timeout", error.message, { retryable: true });
        if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)) return new ProviderError("network", error.message, { retryable: true });
        return new ProviderError("unknown", error.message || "Provider request failed", { retryable: false });
    }
    return new ProviderError("unknown", String(error || "Provider request failed"), { retryable: false });
}

export function toTaskError(error: unknown): TaskErrorInfo {
    const provider = fromUnknownError(error);
    return {
        code: provider.code,
        message: provider.message,
        ...(provider.status !== undefined ? { status: provider.status } : {}),
        retryable: provider.retryable,
    };
}

/** Validate user-supplied values before a task is queued; failures are non-retryable config errors. */
export function assertConfigured(target: { baseUrl: string; apiKey: string; model?: string }, options: { modelRequired?: boolean } = {}) {
    if (options.modelRequired && !target.model?.trim()) throw new ProviderError("config", "No model selected", { retryable: false });
    if (!target.baseUrl.trim()) throw new ProviderError("config", "Base URL is not configured", { retryable: false });
    if (!target.apiKey.trim()) throw new ProviderError("config", "API key is not configured", { retryable: false });
}
