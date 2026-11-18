import { ArrowRight, ChevronRight, Clock3, FileText, FolderPlus, HardDrive, Image as ImageIcon, ImagePlus, Maximize2, PlugZap, Plus, ShieldCheck, Sparkles, Video } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

type QuickAction = {
    key: string;
    label: string;
    hint: string;
    icon: ReactNode;
    tone: string;
    onClick: () => void;
};

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {action}
        </div>
    );
}

function formatTimestamp(value: string, locale: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function assetIcon(asset: Asset) {
    if (asset.kind === "image") return <ImageIcon className="size-5" />;
    if (asset.kind === "video") return <Video className="size-5" />;
    return <FileText className="size-5" />;
}

export default function IndexPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const projects = useCanvasStore((state) => state.projects);
    const projectsHydrated = useCanvasStore((state) => state.hydrated);
    const assets = useAssetStore((state) => state.assets);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const config = useConfigStore((state) => state.config);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const imageModelReady = isAiConfigReady(config, config.imageModel || config.model);

    const recentProjects = useMemo(() => [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 4), [projects]);
    const recentAssets = useMemo(() => [...assets].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 6), [assets]);

    useEffect(() => {
        let cancelled = false;
        void fetchPrompts({ pageSize: 8 })
            .then((data) => {
                if (!cancelled) setPrompts(data.items);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const openNewCanvas = () => navigate("/canvas?mode=new");
    const quickActions: QuickAction[] = [
        {
            key: "canvas",
            label: t("desktop.home.newCanvas"),
            hint: t("desktop.home.newCanvasHint"),
            icon: <Maximize2 className="size-5" />,
            tone: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
            onClick: openNewCanvas,
        },
        {
            key: "image",
            label: t("navigation.image"),
            hint: t("desktop.home.imageHint"),
            icon: <ImagePlus className="size-5" />,
            tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
            onClick: () => navigate("/image"),
        },
        {
            key: "video",
            label: t("navigation.video"),
            hint: t("desktop.home.videoHint"),
            icon: <Video className="size-5" />,
            tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
            onClick: () => navigate("/video"),
        },
        {
            key: "prompts",
            label: t("navigation.prompts"),
            hint: t("desktop.home.promptsHint"),
            icon: <Sparkles className="size-5" />,
            tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            onClick: () => navigate("/prompts"),
        },
    ];

    return (
        <main className="h-full overflow-y-auto">
            <div className="mx-auto w-full max-w-[1440px] @container px-6 py-6">
                <section className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">{t("desktop.home.title")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("desktop.home.subtitle")}</p>
                    </div>
                    <Button type="primary" size="large" icon={<Plus className="size-4" />} onClick={openNewCanvas}>
                        {t("desktop.home.newCanvas")}
                    </Button>
                </section>

                <section className="mt-6 grid grid-cols-1 gap-3 @[480px]:grid-cols-2 @[900px]:grid-cols-4">
                    {quickActions.map((action) => (
                        <button key={action.key} type="button" onClick={action.onClick} className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40">
                            <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", action.tone)}>{action.icon}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium">{action.label}</span>
                                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{action.hint}</span>
                            </span>
                            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                        </button>
                    ))}
                </section>

                <section className="mt-8">
                    <SectionHeader
                        title={t("desktop.home.recentProjects")}
                        action={
                            <Button type="link" size="small" onClick={() => navigate("/canvas")} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">
                                {t("desktop.home.viewAll")}
                            </Button>
                        }
                    />
                    {!projectsHydrated ? (
                        <div className="mt-3 grid grid-cols-1 gap-3 @[480px]:grid-cols-2 @[900px]:grid-cols-4">
                            {[0, 1, 2, 3].map((index) => (
                                <div key={index} className="h-[104px] animate-pulse rounded-xl border border-border bg-muted/40" />
                            ))}
                        </div>
                    ) : recentProjects.length ? (
                        <div className="mt-3 grid grid-cols-1 gap-3 @[480px]:grid-cols-2 @[900px]:grid-cols-4">
                            {recentProjects.map((project) => (
                                <button
                                    key={project.id}
                                    type="button"
                                    onClick={() => navigate(`/canvas/${project.id}`)}
                                    className="group rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium">{project.title}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{t("desktop.home.projectMeta", { nodes: project.nodes.length, connections: project.connections.length })}</div>
                                        </div>
                                        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                                    </div>
                                    <div className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                        <Clock3 className="size-3.5" />
                                        <span className="truncate">{formatTimestamp(project.updatedAt, i18n.language)}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-9 text-center">
                            <FolderPlus className="size-7 text-muted-foreground" />
                            <div className="mt-2 text-sm font-medium">{t("desktop.home.emptyProjects")}</div>
                            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t("desktop.home.emptyProjectsHint")}</p>
                            <Button className="mt-4" size="small" onClick={openNewCanvas}>
                                {t("desktop.home.newCanvas")}
                            </Button>
                        </div>
                    )}
                </section>

                <section className="mt-8 grid grid-cols-1 gap-6 @[900px]:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
                    <div className="min-w-0">
                        <SectionHeader
                            title={t("desktop.home.recentAssets")}
                            action={
                                <Button type="link" size="small" onClick={() => navigate("/assets")} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">
                                    {t("desktop.home.viewAll")}
                                </Button>
                            }
                        />
                        {!assetsHydrated ? (
                            <div className="mt-3 grid grid-cols-3 gap-2 @[560px]:grid-cols-6">
                                {[0, 1, 2, 3, 4, 5].map((index) => (
                                    <div key={index} className="aspect-square animate-pulse rounded-lg border border-border bg-muted/40" />
                                ))}
                            </div>
                        ) : recentAssets.length ? (
                            <div className="mt-3 grid grid-cols-3 gap-2 @[560px]:grid-cols-6">
                                {recentAssets.map((asset) => {
                                    const cover = assetCoverUrl(asset);
                                    return (
                                        <button key={asset.id} type="button" onClick={() => navigate("/assets")} className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted/40 text-left" title={asset.title}>
                                            <span className="absolute inset-0 grid place-items-center text-muted-foreground">{assetIcon(asset)}</span>
                                            {cover ? (
                                                <img
                                                    src={cover}
                                                    alt={asset.title}
                                                    loading="lazy"
                                                    className="relative h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                                                    onError={(event) => {
                                                        event.currentTarget.style.visibility = "hidden";
                                                    }}
                                                />
                                            ) : null}
                                            <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-[10px] text-white">{asset.title}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="mt-3 flex min-h-[140px] flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-8 text-center">
                                <ImageIcon className="size-7 text-muted-foreground" />
                                <div className="mt-2 text-sm font-medium">{t("desktop.home.emptyAssets")}</div>
                                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t("desktop.home.emptyAssetsHint")}</p>
                            </div>
                        )}
                    </div>

                    <div className="space-y-3">
                        <div className="rounded-xl border border-border bg-card p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <PlugZap className="size-4" />
                                    {t("desktop.home.modelChannel")}
                                </div>
                                <span
                                    className={cn(
                                        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
                                        imageModelReady ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                                    )}
                                >
                                    <span className={cn("size-1.5 rounded-full", imageModelReady ? "bg-emerald-500" : "bg-amber-500")} />
                                    {imageModelReady ? t("desktop.home.modelReady") : t("desktop.home.modelMissing")}
                                </span>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{imageModelReady ? t("desktop.home.modelReadyHint") : t("desktop.home.modelMissingHint")}</p>
                            {!imageModelReady ? (
                                <Button size="small" className="mt-3" onClick={() => openConfigDialog(false, "channels")}>
                                    {t("desktop.home.configure")}
                                </Button>
                            ) : null}
                        </div>
                        <div className="rounded-xl border border-border bg-card p-4">
                            <div className="flex items-center gap-2 text-sm font-medium">
                                <HardDrive className="size-4" />
                                {t("desktop.home.localFirst")}
                            </div>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("desktop.home.localFirstHint")}</p>
                            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <ShieldCheck className="size-3.5 shrink-0" />
                                <span>{t("desktop.home.localFirstBadge")}</span>
                            </div>
                        </div>
                    </div>
                </section>

                {prompts.length ? (
                    <section className="mt-8 pb-4">
                        <SectionHeader
                            title={t("desktop.home.inspiration")}
                            action={
                                <Button type="link" size="small" onClick={() => navigate("/prompts")} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">
                                    {t("desktop.home.viewAll")}
                                </Button>
                            }
                        />
                        <div className="mt-3 grid grid-cols-1 gap-3 @[560px]:grid-cols-2 @[900px]:grid-cols-4">
                            {prompts.slice(0, 4).map((prompt) => (
                                <button key={prompt.id} type="button" onClick={() => navigate("/prompts")} className="group overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-foreground/20">
                                    <div className="relative aspect-[4/3] overflow-hidden bg-muted/40">
                                        <div className="absolute inset-0 grid place-items-center text-muted-foreground">
                                            <Sparkles className="size-6" />
                                        </div>
                                        {prompt.coverUrl ? (
                                            <img
                                                src={prompt.coverUrl}
                                                alt={prompt.title}
                                                loading="lazy"
                                                className="relative h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"
                                                onError={(event) => {
                                                    event.currentTarget.style.visibility = "hidden";
                                                }}
                                            />
                                        ) : null}
                                    </div>
                                    <div className="p-3">
                                        <div className="truncate text-xs font-medium">{prompt.title}</div>
                                        <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{prompt.prompt}</div>
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {prompt.tags.slice(0, 2).map((tag) => (
                                                <span key={tag} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>
        </main>
    );
}
