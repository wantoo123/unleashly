import { expect, test } from "bun:test";

import { formatLogArg, redactLogValue, redactUrl } from "../src/main/services/log-redaction";

test("redacts secret keys recursively", () => {
    const value = redactLogValue({
        channel: "openai",
        apiKey: "sk-secret",
        nested: { password: "p@ss", token: "abc", safe: "ok" },
        Authorization: "Bearer xyz",
    }) as Record<string, unknown>;
    expect(value.apiKey).toBe("[REDACTED]");
    expect(value.Authorization).toBe("[REDACTED]");
    expect(value.nested).toEqual({ password: "[REDACTED]", token: "[REDACTED]", safe: "ok" });
});

test("redacts credentials in URLs", () => {
    const value = redactUrl("https://api.example.com/v1/images?key=secret&foo=bar&access_token=abc");
    expect(value).toContain("key=%5BREDACTED%5D");
    expect(value).toContain("access_token=%5BREDACTED%5D");
    expect(value).toContain("foo=bar");
    expect(value).not.toContain("secret");
});

test("redacts credentials embedded in free-form log text", () => {
    const value = formatLogArg("request failed for https://api.example.com/v1?key=secret_token&foo=bar Authorization: Bearer abc.def");
    expect(value).toContain("key=[REDACTED]");
    expect(value).toContain("Authorization: [REDACTED]");
    expect(value).not.toContain("secret_token");
    expect(value).not.toContain("abc.def");
});

test("handles errors, circular values, and truncation", () => {
    const error = new Error("boom");
    const formatted = formatLogArg(error);
    expect(formatted).toContain("Error: boom");

    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    expect(redactLogValue(circular)).toEqual({ name: "root", self: "[Circular]" });

    const long = "x".repeat(20_000);
    const redacted = redactLogValue(long) as string;
    expect(redacted.length).toBeLessThan(long.length);
    expect(redacted).toContain("truncated");
});
