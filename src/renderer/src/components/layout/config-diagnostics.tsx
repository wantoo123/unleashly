import { Activity, AlertTriangle, Cpu, Download, FileText, FolderOpen, HardDrive, ListChecks, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Tag } from "antd";
import { useTranslation } from "react-i18next";

import type { CrashReportSummary, DiagnosticsSummary } from "@shared/diagnostics";
import { formatBytes } from "@/lib/image-utils";
import { clearCrashReports, exportDiagnosticsPackage, getDiagnosticsSummary, listCrashReports, openCrashReportDirectory, openLogDirectory } from "@/platform/diagnostics";
import { isDesktopRuntime } from "@/platform/bridge";

export function ConfigDiagnostics({ active }: { active: boolean }) {
    const { t, i18n } = useTranslation();
    const { message, modal } = App.useApp();
    const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
    const [crashes, setCrashes] = useState<CrashReportSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [nextSummary, nextCrashes] = await Promise.all([getDiagnosticsSummary(), listCrashReports()]);
            setSummary(nextSummary);
            setCrashes(nextCrashes);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (active && !summary) void refresh();
    }, [active, refresh, summary]);

    const exportPackage = async () => {
        setExporting(true);
        try {
            const result = await exportDiagnosticsPackage();
            if (!result.canceled) message.success(t("diagnostics.exported", { path: result.filePath || "", size: formatBytes(result.bytes || 0) }));
        } catch (nextError) {
            message.error(nextError instanceof Error ? nextError.message : String(nextError));
        } finally {
            setExporting(false);
        }
    };

    const clearCrashes = () => {
        modal.confirm({
            title: t("diagnostics.clearCrashesTitle"),
            content: t("diagnostics.clearCrashesDescription"),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                const count = await clearCrashReports();
                message.success(t("diagnostics.crashesCleared", { count }));
                await refresh();
            },
        });
    };

    if (!isDesktopRuntime()) {
        return <Empty description={t("diagnostics.desktopOnly")} className="py-16" />;
    }

    const app = summary?.app;
    const latestCrash = crashes[0];
    const logSize = summary ? formatBytes(summary.log.totalBytes) : "-";
    const taskStats = summary?.taskStats;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <Activity className="size-4" />
                        {t("diagnostics.title")}
                    </div>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-stone-500 dark:text-stone-400">{t("diagnostics.description")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => void refresh()} loading={loading}>
                        {t("diagnostics.refresh")}
                    </Button>
                    <Button type="primary" icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportPackage()}>
                        {t("diagnostics.exportPackage")}
                    </Button>
                </div>
            </div>

            {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">{error}</div> : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <InfoCard icon={<Cpu className="size-4" />} label={t("diagnostics.cards.app")} value={app ? `v${app.version}` : "-"} hint={app ? `${app.platform}/${app.arch} · Electron ${app.electron}` : t("diagnostics.loading")} />
                <InfoCard
                    icon={<FileText className="size-4" />}
                    label={t("diagnostics.cards.logs")}
                    value={logSize}
                    hint={summary ? t("diagnostics.cards.logsHint", { count: summary.log.files.length, level: summary.log.level }) : t("diagnostics.loading")}
                />
                <InfoCard
                    icon={<AlertTriangle className="size-4" />}
                    label={t("diagnostics.cards.crashes")}
                    value={String(crashes.length)}
                    hint={latestCrash ? t("diagnostics.cards.latestCrash", { time: formatTime(latestCrash.timestamp, i18n.resolvedLanguage) }) : t("diagnostics.cards.noCrashes")}
                    tone={crashes.length ? "danger" : "default"}
                />
                <InfoCard
                    icon={<ListChecks className="size-4" />}
                    label={t("diagnostics.cards.tasks")}
                    value={taskStats ? `${taskStats.succeeded}/${taskStats.total}` : "-"}
                    hint={taskStats ? t("diagnostics.cards.tasksHint", { failed: taskStats.failed, running: taskStats.running }) : t("diagnostics.noTaskService")}
                />
            </div>

            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <AlertTriangle className="size-4" />
                        {t("diagnostics.crashReports")}
                    </div>
                    <div className="flex gap-2">
                        <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={() => void openCrashReportDirectory()}>
                            {t("diagnostics.openCrashFolder")}
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!crashes.length} onClick={clearCrashes}>
                            {t("diagnostics.clearCrashes")}
                        </Button>
                    </div>
                </div>
                <div className="mt-3 space-y-2">
                    {crashes.slice(0, 20).map((crash) => (
                        <div key={crash.id} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                            <div className="flex flex-wrap items-center gap-2">
                                <Tag className="m-0" color={crash.process === "main" ? "red" : crash.process === "renderer" ? "orange" : "default"}>
                                    {t(`diagnostics.crashKinds.${crash.kind}`)}
                                </Tag>
                                <span className="text-xs text-stone-500">{formatTime(crash.timestamp, i18n.resolvedLanguage)}</span>
                                {crash.reason ? <Tag className="m-0">{crash.reason}</Tag> : null}
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-300">{crash.message}</p>
                        </div>
                    ))}
                    {!crashes.length ? <div className="rounded-md border border-dashed border-stone-200 px-3 py-8 text-center text-xs text-stone-500 dark:border-stone-800">{t("diagnostics.noCrashes")}</div> : null}
                </div>
            </section>

            <section className="grid gap-3 xl:grid-cols-2">
                <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <HardDrive className="size-4" />
                            {t("diagnostics.paths")}
                        </div>
                        <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={() => void openLogDirectory()}>
                            {t("diagnostics.openLogs")}
                        </Button>
                    </div>
                    <div className="mt-3 space-y-2 text-xs">
                        <PathRow label={t("diagnostics.path.userData")} value={summary?.paths.userData} />
                        <PathRow label={t("diagnostics.path.logs")} value={summary?.paths.logs} />
                        <PathRow label={t("diagnostics.path.crashReports")} value={summary?.paths.crashReports} />
                        <PathRow label={t("diagnostics.path.crashDumps")} value={summary?.paths.crashDumps} />
                    </div>
                </div>
                <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <FileText className="size-4" />
                        {t("diagnostics.recentLogs")}
                    </div>
                    <pre className="thin-scrollbar mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-stone-200 bg-stone-50 p-3 text-[11px] leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
                        {summary?.log.recent.length ? summary.log.recent.slice(-80).join("\n") : t("diagnostics.noLogs")}
                    </pre>
                </div>
            </section>

            <p className="text-[11px] leading-5 text-stone-400">{t("diagnostics.privacyHint")}</p>
        </div>
    );
}

function InfoCard({ icon, label, value, hint, tone = "default" }: { icon: React.ReactNode; label: string; value: string; hint: string; tone?: "default" | "danger" }) {
    return (
        <div className={`rounded-lg border p-4 ${tone === "danger" ? "border-red-200 bg-red-50/60 dark:border-red-950 dark:bg-red-950/10" : "border-stone-200 dark:border-stone-800"}`}>
            <div className={`flex items-center gap-2 text-xs font-medium ${tone === "danger" ? "text-red-500" : "text-stone-500 dark:text-stone-400"}`}>
                {icon}
                {label}
            </div>
            <div className="mt-1.5 truncate text-xl font-semibold">{value}</div>
            <div className="mt-0.5 truncate text-[11px] text-stone-500 dark:text-stone-400">{hint}</div>
        </div>
    );
}

function PathRow({ label, value }: { label: string; value?: string }) {
    return (
        <div className="flex items-center justify-between gap-3 rounded-md bg-stone-50 px-2.5 py-2 dark:bg-stone-900/50">
            <span className="shrink-0 text-stone-500">{label}</span>
            <span className="min-w-0 truncate font-mono text-[11px]" title={value}>
                {value || "-"}
            </span>
        </div>
    );
}

function formatTime(value: string, locale?: string) {
    return new Date(value).toLocaleString(locale || "zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
