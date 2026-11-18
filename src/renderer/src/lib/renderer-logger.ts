import type { LogLevel } from "@shared/diagnostics";

import { getDesktopBridge } from "@/platform/bridge";

/**
 * Renderer-side structured logging. Logs are forwarded to the main process so
 * they are included in local log files and exported diagnostic bundles.
 * Console output is preserved so DevTools remains useful during development.
 */
function write(level: LogLevel, message: string, meta?: unknown) {
    const method = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
    if (meta === undefined) method(message);
    else method(message, meta);
    const bridge = getDesktopBridge();
    if (!bridge?.logs) return;
    void bridge.logs.write(meta === undefined ? { level, message } : { level, message, meta }).catch(() => undefined);
}

export const rendererLog = {
    debug: (message: string, meta?: unknown) => write("debug", message, meta),
    info: (message: string, meta?: unknown) => write("info", message, meta),
    warn: (message: string, meta?: unknown) => write("warn", message, meta),
    error: (message: string, meta?: unknown) => write("error", message, meta),
};
