import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { DesktopHeader } from "@/components/layout/desktop-header";
import { DesktopSidebar } from "@/components/layout/desktop-sidebar";
import { useAgentAutoConnect } from "@/hooks/use-agent-auto-connect";
import { subscribeTaskOpen } from "@/platform/task-events";

const SIDEBAR_COLLAPSED_KEY = "unleashly:sidebar-collapsed";

function readSidebarCollapsed() {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
    const isCanvasEditor = /^\/canvas\/[^/]+/.test(pathname);
    useAgentAutoConnect();

    // Menu bar and notification clicks send this event from the main process.
    useEffect(
        () =>
            subscribeTaskOpen((event) => {
                navigate(event.taskId ? `/tasks?task=${encodeURIComponent(event.taskId)}` : "/tasks");
            }),
        [navigate],
    );

    const toggleSidebar = useCallback(() => {
        setCollapsed((value) => {
            const next = !value;
            try {
                localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
            } catch {
                // Ignore storage failures; the sidebar still toggles for this session.
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (isCanvasEditor) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return;
            const target = event.target;
            if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
            event.preventDefault();
            toggleSidebar();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isCanvasEditor, toggleSidebar]);

    // The canvas editor is a full-bleed workspace; keep the application chrome out of the way.
    if (isCanvasEditor) {
        return (
            <div className="flex h-dvh overflow-hidden bg-background text-foreground">
                <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
                <AgentPanel />
                <AppConfigModal />
            </div>
        );
    }

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <DesktopSidebar collapsed={collapsed} onToggle={toggleSidebar} />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <DesktopHeader />
                <div className="flex min-h-0 flex-1 overflow-hidden">
                    <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
                    <AgentPanel />
                </div>
            </div>
            <AppConfigModal />
        </div>
    );
}
