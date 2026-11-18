import type { CrashReportSummary, DiagnosticsExportResult, DiagnosticsSummary } from "@shared/diagnostics";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { getDesktopBridge } from "./bridge";

export function sanitizeConfigForDiagnostics(config: AiConfig) {
    const { channels, apiKey, systemPrompt, audioInstructions, ...rest } = config;
    return {
        ...rest,
        apiKey: "[REDACTED]",
        systemPrompt: systemPrompt ? "[omitted]" : "",
        audioInstructions: audioInstructions ? "[omitted]" : "",
        channels: channels.map(({ apiKey: channelKey, models, ...channel }) => ({
            ...channel,
            apiKey: channelKey ? "[REDACTED]" : "",
            models: models.map(({ script, ...model }) => ({
                ...model,
                ...(script ? { script: "[script omitted]" } : {}),
            })),
        })),
    };
}

export async function exportDiagnosticsPackage(note?: string): Promise<DiagnosticsExportResult> {
    const bridge = getDesktopBridge();
    if (!bridge?.diagnostics) throw new Error("Diagnostics are only available in the desktop app");
    const state = useConfigStore.getState();
    const webdav = {
        url: state.webdav.url,
        username: state.webdav.username,
        directory: state.webdav.directory,
        lastSyncedAt: state.webdav.lastSyncedAt,
    };
    return bridge.diagnostics.export({
        ...(note ? { note } : {}),
        rendererConfig: {
            config: sanitizeConfigForDiagnostics(state.config),
            webdav,
            locale: typeof localStorage !== "undefined" ? localStorage.getItem("infinite-canvas:locale") : null,
        },
    });
}

export async function getDiagnosticsSummary(): Promise<DiagnosticsSummary | null> {
    const bridge = getDesktopBridge();
    if (!bridge?.diagnostics) return null;
    return bridge.diagnostics.summary();
}

export async function listCrashReports(): Promise<CrashReportSummary[]> {
    const bridge = getDesktopBridge();
    if (!bridge?.diagnostics) return [];
    return bridge.diagnostics.listCrashes();
}

export async function clearCrashReports() {
    const bridge = getDesktopBridge();
    if (!bridge?.diagnostics) return 0;
    return bridge.diagnostics.clearCrashes();
}

export async function openLogDirectory() {
    await getDesktopBridge()?.diagnostics.openLogs();
}

export async function openCrashReportDirectory() {
    await getDesktopBridge()?.diagnostics.openCrashes();
}
