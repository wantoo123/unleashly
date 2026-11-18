import type { RendererCrashReport } from "@shared/diagnostics";

import { getDesktopBridge } from "@/platform/bridge";
import { rendererLog } from "./renderer-logger";

const DEDUPE_WINDOW_MS = 5_000;
const recentReports = new Map<string, number>();
let installed = false;

const IGNORED_MESSAGES = [/ResizeObserver loop/i, /^Script error\.?$/i, /The user aborted a request/i];

function messageOf(value: unknown) {
    if (value instanceof Error) return value.message || value.name || "Unknown error";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value).slice(0, 8_000);
    } catch {
        return String(value);
    }
}

function stackOf(value: unknown) {
    return value instanceof Error && value.stack ? value.stack : undefined;
}

function isExpectedCancellation(value: unknown) {
    return value instanceof Error && (value.name === "AbortError" || value.message === "AbortError");
}

function shouldIgnore(message: string) {
    return IGNORED_MESSAGES.some((pattern) => pattern.test(message));
}

function dedupe(key: string) {
    const timestamp = Date.now();
    const previous = recentReports.get(key) || 0;
    if (timestamp - previous < DEDUPE_WINDOW_MS) return false;
    recentReports.set(key, timestamp);
    if (recentReports.size > 100) {
        for (const [entry, value] of recentReports) {
            if (timestamp - value > DEDUPE_WINDOW_MS * 4) recentReports.delete(entry);
        }
    }
    return true;
}

export function reportRendererCrash(report: RendererCrashReport) {
    const message = report.message || "Unknown renderer error";
    if (shouldIgnore(message)) return;
    const key = `${report.kind}:${message}:${report.source || ""}:${report.line || 0}`;
    if (!dedupe(key)) return;

    rendererLog.error(`[crash] ${report.kind}: ${message}`, report.stack ? `${report.stack}` : undefined);
    const bridge = getDesktopBridge();
    if (!bridge?.diagnostics) return;
    void bridge.diagnostics
        .reportCrash({
            ...report,
            message: message.slice(0, 8_000),
            ...(report.stack ? { stack: report.stack.slice(0, 32_000) } : {}),
            metadata: {
                href: typeof location !== "undefined" ? location.href : "",
                userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
                ...(report.metadata || {}),
            },
        })
        .catch(() => undefined);
}

/** Install window-level handlers once, before React mounts. */
export function installGlobalErrorReporting() {
    if (installed || typeof window === "undefined") return;
    installed = true;

    window.addEventListener("error", (event) => {
        if (!event.error) return; // Resource load errors are handled by the UI that requested them.
        reportRendererCrash({
            kind: "renderer-error",
            message: messageOf(event.error),
            stack: stackOf(event.error),
            source: event.filename || "",
            line: event.lineno || undefined,
            column: event.colno || undefined,
        });
    });

    window.addEventListener("unhandledrejection", (event) => {
        if (isExpectedCancellation(event.reason)) return;
        reportRendererCrash({
            kind: "renderer-unhandled-rejection",
            message: messageOf(event.reason),
            stack: stackOf(event.reason),
        });
    });
}

export function reportReactError(error: unknown, componentStack?: string) {
    reportRendererCrash({
        kind: "renderer-react-error",
        message: messageOf(error),
        stack: stackOf(error),
        metadata: componentStack ? { componentStack: componentStack.slice(0, 16_000) } : undefined,
    });
}
