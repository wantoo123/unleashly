import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CrashReport, CrashReportKind, CrashReportSummary } from "@shared/diagnostics";
import { log } from "./logger";
import { redactLogValue } from "./log-redaction";

const MAX_REPORTS = 50;
const MAX_MESSAGE = 8_000;
const MAX_STACK = 32_000;

export type CrashReportInput = {
    kind: CrashReportKind;
    process: CrashReport["process"];
    message: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
    reason?: string;
    exitCode?: number;
    metadata?: Record<string, unknown>;
};

export function crashReportDirectory() {
    return join(app.getPath("userData"), "crash-reports");
}

export function crashDumpDirectory() {
    try {
        return app.getPath("crashDumps");
    } catch {
        return join(app.getPath("userData"), "crash-dumps");
    }
}

function truncate(value: unknown, max: number) {
    const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
    const redacted = redactLogValue(text);
    const safe = typeof redacted === "string" ? redacted : text;
    return safe.length > max ? `${safe.slice(0, max)}… [truncated ${safe.length - max} chars]` : safe;
}

function appSnapshot() {
    return {
        name: app.getName(),
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        locale: (() => {
            try {
                return app.getLocale();
            } catch {
                return "";
            }
        })(),
    };
}

function safeMetadata(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return undefined;
    try {
        const redacted = redactLogValue(value);
        if (redacted && typeof redacted === "object") return redacted as Record<string, unknown>;
    } catch {
        // Ignore metadata that cannot be serialized.
    }
    return undefined;
}

export async function recordCrash(input: CrashReportInput): Promise<CrashReport | null> {
    try {
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        const file = `${timestamp.replace(/[:.]/g, "-")}-${id}.json`;
        const report: CrashReport = {
            id,
            timestamp,
            kind: input.kind,
            process: input.process,
            message: truncate(input.message, MAX_MESSAGE) || "Unknown error",
            ...(input.stack ? { stack: truncate(input.stack, MAX_STACK) } : {}),
            ...(input.source ? { source: truncate(input.source, 2_048) } : {}),
            ...(typeof input.line === "number" ? { line: input.line } : {}),
            ...(typeof input.column === "number" ? { column: input.column } : {}),
            ...(input.reason ? { reason: truncate(input.reason, 1_000) } : {}),
            ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
            app: appSnapshot(),
            ...(safeMetadata(input.metadata) ? { metadata: safeMetadata(input.metadata) } : {}),
        };
        await mkdir(crashReportDirectory(), { recursive: true });
        await writeFile(join(crashReportDirectory(), file), JSON.stringify(report, null, 2), "utf8");
        await pruneReports();
        log.error(`Crash report recorded: ${report.kind}`, { id, file, message: report.message });
        return report;
    } catch (error) {
        log.error("Failed to record crash report", error);
        return null;
    }
}

async function pruneReports() {
    try {
        const files = await listReportFiles();
        for (const item of files.slice(MAX_REPORTS)) await rm(item.path, { force: true });
    } catch {
        // Ignore pruning failures.
    }
}

async function listReportFiles() {
    try {
        const entries = await readdir(crashReportDirectory());
        const files = await Promise.all(
            entries
                .filter((file) => file.endsWith(".json"))
                .map(async (file) => {
                    const path = join(crashReportDirectory(), file);
                    const info = await stat(path);
                    return { file, path, mtime: info.mtimeMs };
                }),
        );
        return files.sort((left, right) => right.mtime - left.mtime);
    } catch {
        return [];
    }
}

function toSummary(report: CrashReport): CrashReportSummary {
    return {
        id: report.id,
        timestamp: report.timestamp,
        kind: report.kind,
        process: report.process,
        message: report.message,
        ...(report.reason ? { reason: report.reason } : {}),
        ...(typeof report.exitCode === "number" ? { exitCode: report.exitCode } : {}),
        file: `${report.timestamp.replace(/[:.]/g, "-")}-${report.id}.json`,
    };
}

export async function listCrashReports(limit = MAX_REPORTS): Promise<CrashReportSummary[]> {
    const files = await listReportFiles();
    const reports = await Promise.all(
        files.slice(0, Math.max(1, limit)).map(async (item) => {
            try {
                const report = JSON.parse(await readFile(item.path, "utf8")) as CrashReport;
                if (!report?.timestamp || !report?.message) return null;
                return toSummary({ ...report, file: item.file });
            } catch {
                return null;
            }
        }),
    );
    return reports.filter((report): report is CrashReportSummary => Boolean(report));
}

export async function readCrashReportFiles(): Promise<Array<{ name: string; data: Buffer }>> {
    const files = await listReportFiles();
    const result: Array<{ name: string; data: Buffer }> = [];
    for (const item of files) {
        try {
            result.push({ name: item.file, data: await readFile(item.path) });
        } catch {
            // Skip unreadable files.
        }
    }
    return result;
}

export async function clearCrashReports() {
    const files = await listReportFiles();
    await Promise.all(files.map((item) => rm(item.path, { force: true })));
    log.info(`Cleared ${files.length} crash reports`);
    return files.length;
}

export async function listCrashDumps() {
    try {
        const dir = crashDumpDirectory();
        const entries = await readdir(dir);
        const files = await Promise.all(
            entries
                .filter((file) => !["attachments", "completed", "new", "pending", "reports"].includes(file))
                .map(async (file) => {
                    try {
                        const info = await stat(join(dir, file));
                        return info.isFile() ? { name: file, bytes: info.size, updatedAt: info.mtime.toISOString(), path: join(dir, file) } : null;
                    } catch {
                        return null;
                    }
                }),
        );
        return files.filter((file): file is { name: string; bytes: number; updatedAt: string; path: string } => Boolean(file));
    } catch {
        return [];
    }
}

export async function readCrashDumpFiles(maxTotalBytes = 50 * 1024 * 1024) {
    const dumps = await listCrashDumps();
    const selected: Array<{ name: string; data: Buffer }> = [];
    let total = 0;
    for (const dump of dumps) {
        if (total + dump.bytes > maxTotalBytes) break;
        try {
            selected.push({ name: dump.name, data: await readFile(dump.path) });
            total += dump.bytes;
        } catch {
            // Skip unreadable dumps.
        }
    }
    return selected;
}
