import { inspect } from "node:util";

const SENSITIVE_KEY = /(?:api[-_]?key|apikey|authorization|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|credential|cookie)/i;
const URL_SECRET_PARAMS = ["key", "api_key", "apikey", "token", "access_token", "refresh_token", "password", "secret", "authorization"];
const MAX_STRING = 16_000;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 80;

export function redactUrl(value: string) {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return value;
        let changed = false;
        for (const key of URL_SECRET_PARAMS) {
            if (!url.searchParams.has(key)) continue;
            url.searchParams.set(key, "[REDACTED]");
            changed = true;
        }
        return changed ? url.toString() : value;
    } catch {
        return value;
    }
}

function truncate(value: string) {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated ${value.length - MAX_STRING} chars]` : value;
}

/**
 * Redact credentials that appear inside free-form log text, not only structured
 * metadata. Providers often echo query strings into error messages.
 */
export function redactLogString(value: string) {
    let output = redactUrl(value);
    output = output.replace(/([?&](?:key|api_key|apikey|token|access_token|refresh_token|password|secret|authorization)=)[^&\s"'<>]+/gi, "$1[REDACTED]");
    output = output.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
    output = output.replace(/(\bauthorization\b\s*[:=]\s*)(?:bearer\s+)?[^"'\s,;}]+/gi, "$1[REDACTED]");
    output = output.replace(/(\b(?:api[-_]?key|apikey|password|passwd|secret|token|access[-_]?token)\b\s*[:=]\s*)(["']?)[^"'\s,;}]+/gi, "$1$2[REDACTED]");
    return truncate(output);
}

/**
 * Convert arbitrary log metadata into a JSON-safe, secret-free value.
 * This protects diagnostic bundles from leaking API keys or signed URLs even if
 * a future caller logs a whole config object by mistake.
 */
export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactLogString(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return typeof value === "bigint" ? `${value}n` : value;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Error) {
        return { name: value.name, message: truncate(value.message), stack: value.stack ? truncate(value.stack) : undefined };
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return "[Max depth]";
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactLogValue(item, seen, depth + 1));
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
            output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactLogValue(item, seen, depth + 1);
        }
        return output;
    } finally {
        seen.delete(value);
    }
}

export function formatLogArg(value: unknown) {
    if (typeof value === "string") return redactLogString(value);
    if (value instanceof Error) return `${value.name}: ${redactLogString(value.message)}${value.stack ? `\n${redactLogString(value.stack)}` : ""}`;
    if (typeof value === "object" && value !== null) return inspect(redactLogValue(value), { depth: 5, breakLength: 140, colors: false, maxArrayLength: 50, maxStringLength: MAX_STRING });
    return String(value);
}

export function formatLogMessage(args: unknown[]) {
    return args.map(formatLogArg).join(" ");
}
