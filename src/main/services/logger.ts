import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { LogLevel } from "@shared/diagnostics";
import { formatLogMessage } from "./log-redaction";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 10;
const RING_LIMIT = 800;
const VALID_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type LogEntry = {
    timestamp: string;
    level: LogLevel;
    scope: string;
    message: string;
};

const ring: LogEntry[] = [];
let configuredLevel: LogLevel = normalizeLevel(process.env.UNLEASHLY_LOG_LEVEL) || "info";
let currentSize = -1;
let initialized = false;

function normalizeLevel(value: unknown): LogLevel | null {
    return typeof value === "string" && VALID_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : null;
}

export function logDirectory() {
    return join(app.getPath("userData"), "logs");
}

export function activeLogFile() {
    return join(logDirectory(), "main.log");
}

function ensureDirectory() {
    if (initialized) return;
    initialized = true;
    try {
        mkdirSync(logDirectory(), { recursive: true });
    } catch {
        // Logging must never crash the app.
    }
    try {
        currentSize = statSync(activeLogFile()).size;
    } catch {
        currentSize = 0;
    }
}

function rotateIfNeeded(incomingBytes: number) {
    if (currentSize + incomingBytes <= MAX_LOG_BYTES) return;
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        let target = join(logDirectory(), `main-${timestamp}.log`);
        let suffix = 1;
        while (existsSync(target)) target = join(logDirectory(), `main-${timestamp}-${suffix++}.log`);
        renameSync(activeLogFile(), target);
        currentSize = 0;
        pruneRotatedFiles();
    } catch {
        // Missing file or a locked file: keep appending to the active log.
    }
}

function pruneRotatedFiles() {
    try {
        const files = readdirSync(logDirectory())
            .filter((file) => /^main-.+\.log$/.test(file))
            .map((file) => ({ file, mtime: statSync(join(logDirectory(), file)).mtimeMs }))
            .sort((left, right) => right.mtime - left.mtime);
        for (const item of files.slice(MAX_ROTATED_FILES)) {
            try {
                rmSync(join(logDirectory(), item.file), { force: true });
            } catch {
                // Ignore files that are still locked.
            }
        }
    } catch {
        // Ignore directory errors.
    }
}

function write(level: LogLevel, scope: string, args: unknown[]) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel]) return;
    ensureDirectory();
    const timestamp = new Date().toISOString();
    const message = formatLogMessage(args);
    const line = `[${timestamp}] [${level.toUpperCase()}] [${scope}] ${message}`;
    ring.push({ timestamp, level, scope, message });
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);

    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    rotateIfNeeded(bytes);
    try {
        appendFileSync(activeLogFile(), `${line}\n`, "utf8");
        currentSize += bytes;
    } catch {
        // Ignore file logging failures; the in-memory ring is still available.
    }

    if (!app.isPackaged) {
        const method = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
        method(line);
    }
}

export type ScopedLogger = {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

export function scopedLogger(scope: string): ScopedLogger {
    return {
        debug: (...args: unknown[]) => write("debug", scope, args),
        info: (...args: unknown[]) => write("info", scope, args),
        warn: (...args: unknown[]) => write("warn", scope, args),
        error: (...args: unknown[]) => write("error", scope, args),
    };
}

export const log = scopedLogger("app");

export function setLogLevel(level: LogLevel) {
    configuredLevel = level;
    log.info(`Log level set to ${level}`);
}

export function getLogLevel() {
    return configuredLevel;
}

export function getRecentLogs(limit = 200) {
    const value = Math.max(0, Math.min(RING_LIMIT, Math.floor(limit)));
    return ring.slice(-value).map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`);
}

export function getLogFiles() {
    ensureDirectory();
    try {
        return readdirSync(logDirectory())
            .filter((file) => /^main.*\.log$/.test(file))
            .map((file) => {
                const path = join(logDirectory(), file);
                const info = statSync(path);
                return { name: file, path, bytes: info.size, updatedAt: info.mtime.toISOString() };
            })
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
        return [];
    }
}

export function getLogStats() {
    const files = getLogFiles();
    return {
        level: configuredLevel,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        files: files.map(({ name, bytes, updatedAt }) => ({ name, bytes, updatedAt })),
    };
}
