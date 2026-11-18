import { Menu as MenuIcon } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AgentToggleButton } from "@/components/layout/agent-toggle-button";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { WindowControls } from "@/components/layout/window-controls";
import { getDesktopBridge, getPlatform } from "@/platform/bridge";

const PAGE_SLUGS = new Set(["canvas", "image", "video", "assets", "prompts", "tasks", "config"]);

export function DesktopHeader() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const bridge = getDesktopBridge();
    const showMenuButton = Boolean(bridge) && getPlatform() !== "darwin";
    const slug = pathname.split("/").filter(Boolean)[0];
    const pageTitle = pathname === "/" ? t("desktop.nav.home") : slug === "canvas" ? t("canvas.title") : slug && PAGE_SLUGS.has(slug) ? t(`navigation.${slug}`) : t("meta.title");

    return (
        <header className="app-drag flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 pl-5 pr-0 backdrop-blur">
            <div className="flex min-w-0 items-center gap-2.5">
                {showMenuButton ? (
                    <button
                        type="button"
                        onClick={() => void bridge?.app.showMenu()}
                        title={t("desktop.window.menu")}
                        aria-label={t("desktop.window.menu")}
                        className="app-no-drag grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <MenuIcon className="size-4" />
                    </button>
                ) : null}
                <h1 className="truncate text-sm font-semibold tracking-tight">{pageTitle}</h1>
                <span className="hidden rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">{t("desktop.header.local")}</span>
            </div>
            <div className="app-no-drag flex h-full shrink-0 items-center gap-1 pl-1">
                <AgentToggleButton />
                <UserStatusActions showConfig={false} showDocs={false} showGithub={false} />
                <WindowControls />
            </div>
        </header>
    );
}
