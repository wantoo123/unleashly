import { expect, test } from "bun:test";

import { ProviderError, classifyHttpStatus, classifyMessage, fromUnknownError, isContentPolicyMessage, readErrorMessage, toTaskError } from "../src/main/services/gateway/errors";

test("classifies HTTP statuses into stable error codes and retry policy", () => {
    expect(classifyHttpStatus(401)).toEqual({ code: "auth", retryable: false });
    expect(classifyHttpStatus(403)).toEqual({ code: "auth", retryable: false });
    expect(classifyHttpStatus(404)).toEqual({ code: "not_found", retryable: false });
    expect(classifyHttpStatus(429)).toEqual({ code: "rate_limit", retryable: true });
    expect(classifyHttpStatus(500)).toEqual({ code: "server", retryable: true });
    expect(classifyHttpStatus(503)).toEqual({ code: "server", retryable: true });
    expect(classifyHttpStatus(400)).toEqual({ code: "invalid_request", retryable: false });
});

test("reads provider error messages from common payload shapes", () => {
    expect(readErrorMessage({ error: { message: "bad key" } })).toBe("bad key");
    expect(readErrorMessage({ msg: "quota exceeded" })).toBe("quota exceeded");
    expect(readErrorMessage({ error: "plain text" })).toBe("plain text");
    expect(readErrorMessage(JSON.stringify({ error: { message: "nested" } }))).toBe("nested");
    expect(readErrorMessage("")).toBe("");
});

test("detects content policy failures and makes them non-retryable", () => {
    expect(isContentPolicyMessage("The request was blocked by content policy")).toBe(true);
    expect(isContentPolicyMessage("safety system rejected the prompt")).toBe(true);
    expect(isContentPolicyMessage("rate limited")).toBe(false);
    const error = classifyMessage("Request blocked by content policy");
    expect(error.code).toBe("content_policy");
    expect(error.retryable).toBe(false);
});

test("normalizes unknown errors and preserves abort semantics", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(fromUnknownError(abort).code).toBe("canceled");
    expect(fromUnknownError(new TypeError("fetch failed")).code).toBe("network");
    expect(fromUnknownError(new TypeError("fetch failed")).retryable).toBe(true);
    const timeout = new ProviderError("timeout", "took too long", { retryable: true });
    expect(toTaskError(timeout)).toEqual({ code: "timeout", message: "took too long", retryable: true });
});
