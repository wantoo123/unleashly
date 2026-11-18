import { app, dialog, screen, shell, type BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DiagnosticsExportRequest, DiagnosticsExportResult, DiagnosticsSummary } from "@shared/diagnostics";
import { clearCrashReports, crashDumpDirectory, crashReportDirectory, listCrashDumps, listCrashReports, readCrashDumpFiles, readCrashReportFiles } from "./crash-reports";
import { getLogFiles, getLogLevel, getLogStats, getRecentLogs, log, logDirectory } from "./logger";
import { redactLogValue } from "./log-redaction";
import { getTaskQueueIfReady } from "./task-service";
import { createZip } from "./zip-store";

function appInfo() {
    return {
        name: app.getName(),
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        locale: (() => {
            try {
                return app.getLocale();
            } catch {
                return "";
            }
        })(),
        systemLocale: app.getSystemLocale(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
    };
}

function memoryInfo() {
    const memory = process.memoryUsage();
    return { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal };
}

function displayInfo() {
    try {
        return screen.getAllDisplays().map((display) => ({
            id: display.id,
            width: display.size.width,
            height: display.size.height,
            scaleFactor: display.scaleFactor,
            rotation: display.rotation,
            internal: display.internal,
        }));
    } catch {
        return [];
    }
}

async function gpuInfo() {
    try {
        return await app.getGPUInfo("basic");
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

export async function collectDiagnostics(extra: DiagnosticsExportRequest = {}): Promise<DiagnosticsSummary> {
    const [crashes, crashDumps, gpu] = await Promise.all([listCrashReports(20), listCrashDumps(), gpuInfo()]);
    const logStats = getLogStats();
    const taskStats = getTaskQueueIfReady()?.stats() ?? null;
    return {
        generatedAt: new Date().toISOString(),
        app: appInfo(),
        paths: {
            userData: app.getPath("userData"),
            logs: logDirectory(),
            crashReports: crashReportDirectory(),
            crashDumps: crashDumpDirectory(),
            downloads: app.getPath("downloads"),
        },
        log: {
            ...logStats,
            level: getLogLevel(),
            recent: getRecentLogs(120),
        },
        crashes: {
            count: crashes.length,
            ...(crashes[0] ? { latestAt: crashes[0].timestamp } : {}),
            reports: crashes,
        },
        crashDumps: crashDumps.map(({ name, bytes, updatedAt }) => ({ name, bytes, updatedAt })),
        memory: memoryInfo(),
        taskStats,
        displays: displayInfo(),
        gpu,
        ...(extra.rendererConfig !== undefined ? { rendererConfig: redactLogValue(extra.rendererConfig) } : {}),
    } as DiagnosticsSummary & { rendererConfig?: unknown };
}

function timestampForFile() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

const README = `Unleashly diagnostic bundle
============================

Contents
--------
- diagnostics.json : app/system/task/log/crash metadata and redacted renderer config
- logs/            : main-process logs, including forwarded renderer console errors
- crash-reports/   : structured crash reports captured by the app
- crash-dumps/     : native crashpad dumps, when available
- tasks/           : task queue summary (no prompts or credentials)

Privacy
-------
API keys, tokens, passwords, Authorization headers, and URL credentials are
redacted. Generated media and project content are not included.
`;

export async function exportDiagnostics(window: BrowserWindow | null, request: DiagnosticsExportRequest = {}): Promise<DiagnosticsExportResult> {
    const stamp = timestampForFile();
    const defaultPath = join(app.getPath("downloads"), `unleashly-diagnostics-${stamp}.zip`);
    const options = {
        title: "导出诊断包",
        defaultPath,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };

    const diagnostics = await collectDiagnostics(request);
    const files: Record<string, Buffer | string> = {
        "diagnostics.json": JSON.stringify(diagnostics, null, 2),
        "README.txt": README,
    };
    const included: string[] = ["diagnostics.json", "README.txt"];

    for (const file of getLogFiles()) {
        try {
            files[`logs/${file.name}`] = await readFile(file.path);
            included.push(`logs/${file.name}`);
        } catch {
            // Logs can rotate while exporting; skip unreadable files.
        }
    }
    const recent = getRecentLogs(800);
    if (recent.length) {
        files["logs/recent.log"] = `${recent.join("\n")}\n`;
        included.push("logs/recent.log");
    }

    for (const report of await readCrashReportFiles()) {
        files[`crash-reports/${report.name}`] = report.data;
        included.push(`crash-reports/${report.name}`);
    }
    for (const dump of await readCrashDumpFiles()) {
        files[`crash-dumps/${dump.name}`] = dump.data;
        included.push(`crash-dumps/${dump.name}`);
    }

    const summary = getTaskQueueIfReady()?.stats();
    if (summary) {
        files["tasks/summary.json"] = JSON.stringify(summary, null, 2);
        included.push("tasks/summary.json");
    }

    const zip = createZip(files);
    await writeFile(result.filePath, zip);
    log.info("Diagnostic package exported", { path: result.filePath, bytes: zip.length, files: included.length });
    return { canceled: false, filePath: result.filePath, bytes: zip.length, files: included };
}

export async function getDiagnosticsSummary() {
    return collectDiagnostics();
}

export async function openLogDirectory() {
    await mkdir(logDirectory(), { recursive: true });
    const error = await shell.openPath(logDirectory());
    if (error) log.warn("Failed to open log directory", error);
}

export async function openCrashReportDirectory() {
    await mkdir(crashReportDirectory(), { recursive: true });
    const error = await shell.openPath(crashReportDirectory());
    if (error) log.warn("Failed to open crash report directory", error);
}

export async function clearCrashReportDirectory() {
    return clearCrashReports();
}
