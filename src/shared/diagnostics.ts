import type { TaskStats } from "./tasks";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogWriteRequest = {
    level: LogLevel;
    message: string;
    meta?: unknown;
};

export type CrashReportKind =
    "main-uncaught-exception" | "main-unhandled-rejection" | "renderer-crash" | "renderer-error" | "renderer-unhandled-rejection" | "renderer-react-error" | "renderer-bootstrap-error" | "renderer-unresponsive" | "child-process-gone";

export type RendererCrashReport = {
    kind: Extract<CrashReportKind, "renderer-error" | "renderer-unhandled-rejection" | "renderer-react-error" | "renderer-bootstrap-error">;
    message: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
    metadata?: Record<string, unknown>;
};

export type CrashReportSummary = {
    id: string;
    timestamp: string;
    kind: CrashReportKind;
    process: "main" | "renderer" | "gpu" | "utility" | "unknown";
    message: string;
    reason?: string;
    exitCode?: number;
    file: string;
};

export type CrashReport = Omit<CrashReportSummary, "file"> & {
    file?: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
    app: {
        name: string;
        version: string;
        packaged: boolean;
        platform: string;
        arch: string;
        electron: string;
        chrome: string;
        node: string;
        locale: string;
    };
    metadata?: Record<string, unknown>;
};

export type DiagnosticsSummary = {
    generatedAt: string;
    app: {
        name: string;
        version: string;
        packaged: boolean;
        platform: string;
        arch: string;
        locale: string;
        systemLocale: string;
        electron: string;
        chrome: string;
        node: string;
        v8: string;
    };
    paths: {
        userData: string;
        logs: string;
        crashReports: string;
        crashDumps: string;
        downloads: string;
    };
    log: {
        level: LogLevel;
        totalBytes: number;
        files: Array<{ name: string; bytes: number; updatedAt: string }>;
        recent: string[];
    };
    crashes: {
        count: number;
        latestAt?: string;
        reports: CrashReportSummary[];
    };
    crashDumps: Array<{ name: string; bytes: number; updatedAt: string }>;
    memory: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
    };
    taskStats: TaskStats | null;
    displays: Array<{ id: number; width: number; height: number; scaleFactor: number; rotation: number; internal: boolean }>;
    gpu: unknown;
};

export type DiagnosticsExportRequest = {
    /** Renderer-side config snapshot with credentials already removed. */
    rendererConfig?: unknown;
    note?: string;
};

export type DiagnosticsExportResult = {
    canceled: boolean;
    filePath?: string;
    bytes?: number;
    files?: string[];
};
