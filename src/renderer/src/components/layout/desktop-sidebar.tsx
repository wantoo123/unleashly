import { HardDrive, LayoutDashboard, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools } from "@/constant/navigation-tools";
import { getPlatform } from "@/platform/bridge";
import { cn } from "@/lib/utils";

type DesktopSidebarProps = {
    collapsed: boolean;
    onToggle: () => void;
};

const PRIMARY_SLUGS = ["canvas", "image", "video"] as const;
const LIBRARY_SLUGS = ["prompts", "assets"] as const;
const SYSTEM_SLUGS = ["tasks", "config"] as const;

function isActive(pathname: string, slug: string) {
    if (slug === "home") return pathname === "/";
    if (slug === "canvas") return pathname === "/canvas" || pathname.startsWith("/canvas/");
    return pathname === `/${slug}` || pathname.startsWith(`/${slug}/`);
}

export function DesktopSidebar({ collapsed, onToggle }: DesktopSidebarProps) {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const platform = getPlatform();
    const toolsBySlug = new Map<string, (typeof navigationTools)[number]>(navigationTools.map((tool) => [tool.slug, tool]));

    const renderItems = (slugs: readonly string[]) =>
        slugs
            .map((slug) => toolsBySlug.get(slug))
            .filter((tool): tool is (typeof navigationTools)[number] => Boolean(tool))
            .map((tool) => {
                const Icon = tool.icon;
                const label = t(`navigation.${tool.slug}`);
                const active = isActive(pathname, tool.slug);
                return (
                    <Link
                        key={tool.slug}
                        to={`/${tool.slug}`}
                        title={collapsed ? label : undefined}
                        aria-label={label}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                            collapsed && "justify-center px-0",
                            active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                        )}
                    >
                        <Icon className="size-4 shrink-0" />
                        {!collapsed ? <span className="truncate">{label}</span> : null}
                    </Link>
                );
            });

    const homeLabel = t("desktop.nav.home");
    const homeActive = isActive(pathname, "home");

    return (
        <aside className={cn("flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200", collapsed ? "w-16" : "w-[228px]")}>
            <div className={cn("app-drag flex h-14 shrink-0 items-center border-b border-sidebar-border", collapsed ? "justify-center px-0" : platform === "darwin" ? "pl-[84px] pr-4" : "px-4")}>
                <Link to="/" className="app-no-drag flex min-w-0 items-center gap-2.5" title={t("meta.title")}>
                    <img src="/logo.svg" alt="" className="size-5 shrink-0" />
                    {!collapsed ? <span className="truncate text-sm font-semibold tracking-tight">{t("meta.title")}</span> : null}
                </Link>
            </div>

            <nav className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-3">
                <div className="space-y-0.5">
                    <Link
                        to="/"
                        title={collapsed ? homeLabel : undefined}
                        aria-label={homeLabel}
                        aria-current={homeActive ? "page" : undefined}
                        className={cn(
                            "group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                            collapsed && "justify-center px-0",
                            homeActive ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                        )}
                    >
                        <LayoutDashboard className="size-4 shrink-0" />
                        {!collapsed ? <span className="truncate">{homeLabel}</span> : null}
                    </Link>
                </div>

                {!collapsed ? <div className="px-2 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{t("desktop.nav.create")}</div> : <div className="my-3 border-t border-sidebar-border" />}
                <div className="space-y-0.5">{renderItems(PRIMARY_SLUGS)}</div>

                {!collapsed ? <div className="px-2 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{t("desktop.nav.library")}</div> : <div className="my-3 border-t border-sidebar-border" />}
                <div className="space-y-0.5">{renderItems(LIBRARY_SLUGS)}</div>

                {!collapsed ? <div className="px-2 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{t("desktop.nav.system")}</div> : <div className="my-3 border-t border-sidebar-border" />}
                <div className="space-y-0.5">{renderItems(SYSTEM_SLUGS)}</div>
            </nav>

            <div className="shrink-0 border-t border-sidebar-border p-2">
                {!collapsed ? (
                    <div className="mb-2 flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
                        <HardDrive className="size-3.5 shrink-0" />
                        <span className="truncate">{t("desktop.home.localFirst")}</span>
                    </div>
                ) : null}
                <button
                    type="button"
                    onClick={onToggle}
                    title={t(collapsed ? "desktop.sidebar.expand" : "desktop.sidebar.collapse")}
                    aria-label={t(collapsed ? "desktop.sidebar.expand" : "desktop.sidebar.collapse")}
                    aria-keyshortcuts="Control+B"
                    className={cn("flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground", collapsed && "justify-center px-0")}
                >
                    {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
                    {!collapsed ? <span className="truncate">{t("desktop.sidebar.collapse")}</span> : null}
                </button>
            </div>
        </aside>
    );
}
