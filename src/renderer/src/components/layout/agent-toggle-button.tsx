import { Bot } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";

export function AgentToggleButton() {
    const { t } = useTranslation();
    const connected = useAgentStore((state) => state.connected);
    const enabled = useAgentStore((state) => state.enabled);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const label = t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent");

    return (
        <Tooltip title={label} mouseEnterDelay={0.2}>
            <button
                type="button"
                onClick={togglePanel}
                aria-label={label}
                className={cn("inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs transition-colors", panelOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
            >
                <Bot className="size-4" />
                <span className="hidden lg:inline">Agent</span>
                <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : enabled ? "bg-amber-500" : "bg-muted-foreground/40")} />
            </button>
        </Tooltip>
    );
}
