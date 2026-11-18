import { Activity, AlertCircle, Box, CheckCircle2, Clock3, Image as ImageIcon, ListTodo, LoaderCircle, PauseCircle, RefreshCw, RotateCcw, Search, Trash2, Type, Video, Volume2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Button, Drawer, Empty, Progress, Segmented, Select, Switch, Tag, Tooltip } from "antd";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { formatDuration } from "@/lib/image-utils";
import { subscribeTaskChanges } from "@/platform/task-events";
import { getTaskBridge } from "@/platform/tasks";
import type { TaskKind, TaskListFilter, TaskRecord, TaskResultItemPayload, TaskResultPayload, TaskStats, TaskStatus } from "@shared/tasks";

const KIND_ICONS: Record<TaskKind, typeof ListTodo> = {
    image: ImageIcon,
    video: Video,
    audio: Volume2,
    text: Type,
    model3d: Box,
};

const KIND_TONES: Record<TaskKind, string> = {
    image: "bg-blue-500/10 text-blue-500",
    video: "bg-purple-500/10 text-purple-500",
    audio: "bg-cyan-500/10 text-cyan-500",
    text: "bg-indigo-500/10 text-indigo-500",
    model3d: "bg-fuchsia-500/10 text-fuchsia-500",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
    queued: "default",
    running: "processing",
    succeeded: "success",
    failed: "error",
    canceled: "warning",
};

const KIND_COLORS: Record<TaskKind, string> = {
    image: "blue",
    video: "purple",
    audio: "cyan",
    text: "geekblue",
    model3d: "magenta",
};

const STATUS_FILTERS: Array<TaskStatus | "active" | "all"> = ["all", "active", "running", "queued", "succeeded", "failed", "canceled"];
const KIND_FILTERS: Array<TaskKind | "all"> = ["all", "image", "video", "audio", "text", "model3d"];

function statusIcon(status: TaskStatus) {
    if (status === "running") return <LoaderCircle className="size-3.5 animate-spin" />;
    if (status === "queued") return <PauseCircle className="size-3.5" />;
    if (status === "succeeded") return <CheckCircle2 className="size-3.5" />;
    if (status === "failed") return <XCircle className="size-3.5" />;
    return <AlertCircle className="size-3.5" />;
}

function formatTimestamp(value: number | undefined, locale: string) {
    if (!value) return "-";
    return new Date(value).toLocaleString(locale, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function taskDuration(task: TaskRecord) {
    if (!task.startedAt) return 0;
    return Math.max(0, (task.finishedAt || Date.now()) - task.startedAt);
}

function paramsPreview(task: TaskRecord) {
    const params = task.params || {};
    return Object.entries(params)
        .filter(([, value]) => value !== "" && value !== undefined && value !== null && value !== false)
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(",") : String(value)}`);
}

export default function TasksPage() {
    const { t, i18n } = useTranslation();
    const { message, modal } = App.useApp();
    const bridge = getTaskBridge();
    const [searchParams, setSearchParams] = useSearchParams();
    const [tasks, setTasks] = useState<TaskRecord[]>([]);
    const [stats, setStats] = useState<TaskStats | null>(null);
    const [statusFilter, setStatusFilter] = useState<TaskStatus | "active" | "all">("all");
    const [kindFilter, setKindFilter] = useState<TaskKind | "all">("all");
    const [includeHidden, setIncludeHidden] = useState(false);
    const [concurrency, setConcurrency] = useState(3);
    const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("task"));
    const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);
    const [selectedResult, setSelectedResult] = useState<TaskResultPayload | null>(null);
    const [resultLoading, setResultLoading] = useState(false);
    const [blobUrls, setBlobUrls] = useState<Record<number, string>>({});
    const refreshTimerRef = useRef<number | null>(null);

    const refresh = useCallback(async () => {
        if (!bridge) return;
        const filter: TaskListFilter = { status: statusFilter, kind: kindFilter, includeHidden, limit: 200 };
        const [nextTasks, nextStats] = await Promise.all([bridge.list(filter), bridge.stats()]);
        setTasks(nextTasks);
        setStats(nextStats);
    }, [bridge, includeHidden, kindFilter, statusFilter]);

    const scheduleRefresh = useCallback(() => {
        if (refreshTimerRef.current !== null) return;
        refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null;
            void refresh();
        }, 300);
    }, [refresh]);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 5000);
        const unsubscribe = subscribeTaskChanges(() => scheduleRefresh());
        return () => {
            window.clearInterval(timer);
            unsubscribe();
            if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
        };
    }, [refresh, scheduleRefresh]);

    useEffect(() => {
        if (!bridge) return;
        void bridge.getConcurrency().then((value) => setConcurrency(value.global));
    }, [bridge]);

    useEffect(() => {
        const taskId = searchParams.get("task");
        if (taskId) setSelectedId(taskId);
    }, [searchParams]);

    const selectedLive = useMemo(() => (selectedId ? tasks.find((task) => task.id === selectedId) || selectedTask : selectedTask), [selectedId, selectedTask, tasks]);

    useEffect(() => {
        if (!bridge || !selectedId) {
            setSelectedTask(null);
            setSelectedResult(null);
            return;
        }
        let cancelled = false;
        setResultLoading(true);
        void bridge
            .get(selectedId)
            .then(async (task) => {
                if (cancelled) return;
                setSelectedTask(task);
                const result = task?.status === "succeeded" ? await bridge.result(selectedId) : null;
                if (!cancelled) setSelectedResult(result);
            })
            .catch(() => {
                if (!cancelled) setSelectedResult(null);
            })
            .finally(() => {
                if (!cancelled) setResultLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [bridge, selectedId]);

    useEffect(() => {
        if (!selectedLive || selectedResult || !bridge || selectedLive.status !== "succeeded") return;
        setResultLoading(true);
        void bridge
            .result(selectedLive.id)
            .then((result) => setSelectedResult(result))
            .finally(() => setResultLoading(false));
    }, [bridge, selectedLive, selectedResult]);

    // Binary results are streamed from the main process; expose them as object URLs
    // and revoke them when the drawer closes or the selection changes.
    useEffect(() => {
        const nextBlobUrls: Record<number, string> = {};
        for (const item of selectedResult?.items || []) {
            if (item.data) nextBlobUrls[item.index] = URL.createObjectURL(new Blob([item.data], { type: item.mimeType }));
        }
        setBlobUrls(nextBlobUrls);
        return () => Object.values(nextBlobUrls).forEach((url) => URL.revokeObjectURL(url));
    }, [selectedResult]);

    const openTask = (task: TaskRecord) => {
        setSelectedId(task.id);
        setSearchParams({ task: task.id });
    };

    const closeDrawer = () => {
        setSelectedId(null);
        setSelectedTask(null);
        setSelectedResult(null);
        setSearchParams({});
    };

    const cancelTask = async (task: TaskRecord) => {
        if (!bridge) return;
        await bridge.cancel(task.id);
        message.success(t("tasks.canceled"));
        void refresh();
    };

    const retryTask = async (task: TaskRecord) => {
        if (!bridge) return;
        await bridge.retry(task.id);
        message.success(t("tasks.retried"));
        void refresh();
    };

    const removeTask = (task: TaskRecord) => {
        if (!bridge) return;
        modal.confirm({
            title: t("tasks.confirmRemoveTitle"),
            content: t("tasks.confirmRemove", { title: task.title }),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                await bridge.remove(task.id);
                if (selectedId === task.id) closeDrawer();
                message.success(t("tasks.removed"));
                void refresh();
            },
        });
    };

    const clearFinished = () => {
        if (!bridge) return;
        modal.confirm({
            title: t("tasks.confirmClearTitle"),
            content: t("tasks.confirmClear"),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                const count = await bridge.clearFinished();
                message.success(t("tasks.cleared", { count }));
                void refresh();
            },
        });
    };

    const changeConcurrency = async (value: number) => {
        if (!bridge) return;
        const next = await bridge.setConcurrency({ global: value });
        setConcurrency(next.global);
        message.success(t("tasks.concurrencyUpdated", { count: next.global }));
    };

    if (!bridge) {
        return (
            <main className="grid h-full place-items-center bg-background p-6">
                <Empty description={t("tasks.unavailable")} />
            </main>
        );
    }

    const activeCount = (stats?.running || 0) + (stats?.queued || 0);
    const successRate = stats ? `${Math.round(stats.successRate * 100)}%` : "-";

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
                <header className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                            <ListTodo className="size-6" />
                            {t("tasks.title")}
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("tasks.subtitle")}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
                            <span className="text-xs text-muted-foreground">{t("tasks.concurrency")}</span>
                            <Select size="small" value={concurrency} style={{ width: 64 }} options={[1, 2, 3, 4, 5, 6, 7, 8].map((value) => ({ value, label: String(value) }))} onChange={(value) => void changeConcurrency(value)} />
                        </div>
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>
                            {t("tasks.refresh")}
                        </Button>
                        <Button danger icon={<Trash2 className="size-4" />} onClick={clearFinished}>
                            {t("tasks.clearFinished")}
                        </Button>
                    </div>
                </header>

                <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <StatCard icon={<Activity className="size-4" />} label={t("tasks.stats.active")} value={String(activeCount)} hint={t("tasks.stats.activeHint", { running: stats?.running || 0, queued: stats?.queued || 0 })} />
                    <StatCard icon={<CheckCircle2 className="size-4" />} label={t("tasks.stats.successRate")} value={successRate} hint={t("tasks.stats.successHint", { succeeded: stats?.succeeded || 0, failed: stats?.failed || 0 })} tone="emerald" />
                    <StatCard icon={<Clock3 className="size-4" />} label={t("tasks.stats.averageDuration")} value={stats ? formatDuration(stats.averageDurationMs) : "-"} hint={t("tasks.stats.totalTasks", { count: stats?.total || 0 })} />
                    <StatCard
                        icon={<ListTodo className="size-4" />}
                        label={t("tasks.stats.usage")}
                        value={t("tasks.stats.usageValue", { images: stats?.usage.images || 0, videos: stats?.usage.videoSeconds || 0, tokens: stats?.usage.totalTokens || 0 })}
                        hint={t("tasks.stats.usageHint")}
                    />
                </section>

                <section className="mt-6 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Segmented value={statusFilter} onChange={(value) => setStatusFilter(value as TaskStatus | "active" | "all")} options={STATUS_FILTERS.map((value) => ({ value, label: t(`tasks.filters.status.${value}`) }))} />
                        <Select value={kindFilter} style={{ width: 140 }} onChange={(value) => setKindFilter(value)} options={KIND_FILTERS.map((value) => ({ value, label: t(`tasks.filters.kind.${value}`) }))} />
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Switch size="small" checked={includeHidden} onChange={setIncludeHidden} />
                            {t("tasks.filters.includeHidden")}
                        </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{t("tasks.showing", { count: tasks.length, total: stats?.total || 0 })}</span>
                </section>

                <section className="mt-3 space-y-2 pb-6">
                    {tasks.map((task) => (
                        <article
                            key={task.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => openTask(task)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") openTask(task);
                            }}
                            className="group cursor-pointer rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent/30"
                        >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                                    <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${KIND_TONES[task.kind]}`}>
                                        <TaskKindIcon kind={task.kind} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                            <span className="truncate text-sm font-semibold">{task.title}</span>
                                            <Tag className="m-0" color={KIND_COLORS[task.kind]}>
                                                {t(`tasks.filters.kind.${task.kind}`)}
                                            </Tag>
                                            <Tag className="m-0" color={STATUS_COLORS[task.status]} icon={statusIcon(task.status)}>
                                                {t(`tasks.status.${task.status}`)}
                                            </Tag>
                                            {task.hidden ? <Tag className="m-0">{t("tasks.hidden")}</Tag> : null}
                                        </div>
                                        <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{task.promptPreview || t("tasks.noPrompt")}</div>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                            <span className="truncate">
                                                {task.provider.channelName ? `${task.provider.channelName} · ` : ""}
                                                {task.provider.model}
                                            </span>
                                            {paramsPreview(task).map((item) => (
                                                <span key={item} className="rounded bg-muted px-1.5 py-0.5">
                                                    {item}
                                                </span>
                                            ))}
                                            {task.attempts > 1 ? <span>{t("tasks.attempts", { count: task.attempts })}</span> : null}
                                        </div>
                                        {task.status === "running" || task.status === "queued" ? (
                                            <div className="mt-2 flex items-center gap-2">
                                                <Progress percent={Math.round((task.progress || 0) * 100)} size="small" showInfo={false} className="!mb-0 max-w-md" />
                                                <span className="shrink-0 text-[11px] text-muted-foreground">{task.phase || ""}</span>
                                            </div>
                                        ) : null}
                                        {task.error && task.status !== "canceled" ? <div className="mt-1.5 line-clamp-1 text-[11px] text-red-500">{task.error.message}</div> : null}
                                    </div>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <span className="text-[11px] text-muted-foreground">{formatTimestamp(task.createdAt, i18n.resolvedLanguage || "zh-CN")}</span>
                                    <Tag className="m-0">{formatDuration(taskDuration(task))}</Tag>
                                    {task.status === "running" || task.status === "queued" ? (
                                        <Tooltip title={t("tasks.actions.cancel")}>
                                            <Button size="small" danger icon={<XCircle className="size-3.5" />} onClick={(event) => (event.stopPropagation(), void cancelTask(task))} />
                                        </Tooltip>
                                    ) : (
                                        <Tooltip title={t("tasks.actions.retry")}>
                                            <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={(event) => (event.stopPropagation(), void retryTask(task))} />
                                        </Tooltip>
                                    )}
                                    <Tooltip title={t("tasks.actions.remove")}>
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={(event) => (event.stopPropagation(), removeTask(task))} />
                                    </Tooltip>
                                </div>
                            </div>
                        </article>
                    ))}
                    {!tasks.length ? (
                        <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border text-center">
                            <Search className="mb-3 size-8 text-muted-foreground" />
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("tasks.empty")} />
                        </div>
                    ) : null}
                </section>
            </div>

            <Drawer title={t("tasks.detail.title")} width={760} open={Boolean(selectedId)} onClose={closeDrawer} destroyOnHidden>
                {selectedLive ? <TaskDetail task={selectedLive} result={selectedResult} loading={resultLoading} blobUrls={blobUrls} /> : <Empty description={t("tasks.notFound")} />}
            </Drawer>
        </main>
    );
}

function TaskKindIcon({ kind }: { kind: TaskKind }) {
    const Icon = KIND_ICONS[kind] || ListTodo;
    return <Icon className="size-4" />;
}

function StatCard({ icon, label, value, hint, tone = "stone" }: { icon: ReactNode; label: string; value: string; hint: string; tone?: "stone" | "emerald" }) {
    return (
        <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className={tone === "emerald" ? "text-emerald-500" : "text-muted-foreground"}>{icon}</span>
                {label}
            </div>
            <div className="mt-1.5 truncate text-xl font-semibold">{value}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>
        </div>
    );
}

function TaskDetail({ task, result, loading, blobUrls }: { task: TaskRecord; result: TaskResultPayload | null; loading: boolean; blobUrls: Record<number, string> }) {
    const { t, i18n } = useTranslation();
    const items = result?.items || [];
    return (
        <div className="space-y-5">
            <div>
                <div className="flex flex-wrap items-center gap-2">
                    <Tag color={KIND_COLORS[task.kind]}>{t(`tasks.filters.kind.${task.kind}`)}</Tag>
                    <Tag color={STATUS_COLORS[task.status]} icon={statusIcon(task.status)}>
                        {t(`tasks.status.${task.status}`)}
                    </Tag>
                    <span className="text-xs text-muted-foreground">{task.id}</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold">{task.title}</h2>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{task.promptPreview || t("tasks.noPrompt")}</p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
                <DetailItem label={t("tasks.detail.channel")} value={task.provider.channelName || task.provider.channelId} />
                <DetailItem label={t("tasks.detail.model")} value={task.provider.model} />
                <DetailItem label={t("tasks.detail.created")} value={formatTimestamp(task.createdAt, i18n.resolvedLanguage || "zh-CN")} />
                <DetailItem label={t("tasks.detail.started")} value={formatTimestamp(task.startedAt, i18n.resolvedLanguage || "zh-CN")} />
                <DetailItem label={t("tasks.detail.finished")} value={formatTimestamp(task.finishedAt, i18n.resolvedLanguage || "zh-CN")} />
                <DetailItem label={t("tasks.detail.duration")} value={formatDuration(taskDuration(task))} />
                <DetailItem label={t("tasks.detail.attempts")} value={`${task.attempts} / ${task.maxAttempts}`} />
                <DetailItem label={t("tasks.detail.priority")} value={t(`tasks.priority.${task.priority}`)} />
            </div>

            {task.status === "running" || task.status === "queued" ? (
                <div>
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                        <span>{task.phase || t(`tasks.status.${task.status}`)}</span>
                        <span>{Math.round((task.progress || 0) * 100)}%</span>
                    </div>
                    <Progress percent={Math.round((task.progress || 0) * 100)} showInfo={false} />
                </div>
            ) : null}

            {task.error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">
                    <div className="mb-1 flex items-center gap-1.5 font-medium">
                        <AlertCircle className="size-4" />
                        {t("tasks.detail.error")} · {task.error.code}
                        {task.error.retryable ? <Tag className="m-0">{t("tasks.detail.retryable")}</Tag> : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-5">{task.error.message}</p>
                </div>
            ) : null}

            <div>
                <h3 className="mb-1.5 text-sm font-semibold">{t("tasks.detail.params")}</h3>
                <pre className="max-h-52 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-5">{JSON.stringify(task.params, null, 2)}</pre>
            </div>

            {task.usage ? (
                <div>
                    <h3 className="mb-1.5 text-sm font-semibold">{t("tasks.detail.usage")}</h3>
                    <div className="flex flex-wrap gap-2 text-xs">
                        {Object.entries(task.usage)
                            .filter(([, value]) => typeof value === "number" && value > 0)
                            .map(([key, value]) => (
                                <Tag key={key} className="m-0">
                                    {key}: {value}
                                </Tag>
                            ))}
                    </div>
                </div>
            ) : null}

            <div>
                <h3 className="mb-1.5 text-sm font-semibold">{t("tasks.detail.result")}</h3>
                {loading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" />
                        {t("tasks.detail.loadingResult")}
                    </div>
                ) : result?.text ? (
                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs leading-6">{result.text}</pre>
                ) : items.length ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {items.map((item) => (
                            <TaskResultItem key={item.index} item={item} blobUrl={blobUrls[item.index]} />
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">{task.status === "succeeded" ? t("tasks.detail.noResult") : t("tasks.detail.resultPending")}</p>
                )}
            </div>
        </div>
    );
}

function DetailItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border bg-muted/20 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-0.5 truncate text-xs font-medium">{value}</div>
        </div>
    );
}

function TaskResultItem({ item, blobUrl }: { item: TaskResultItemPayload; blobUrl?: string }) {
    if (item.kind === "image") {
        const src = item.dataUrl || blobUrl || item.url;
        return src ? <img src={src} alt="" className="w-full rounded-lg border border-border object-contain" /> : null;
    }
    if (item.kind === "video") {
        const src = blobUrl || item.url;
        return src ? <video src={src} controls className="w-full rounded-lg border border-border bg-black" /> : null;
    }
    if (item.kind === "audio") {
        const src = blobUrl || item.url;
        return src ? <audio src={src} controls className="w-full" /> : null;
    }
    return null;
}
