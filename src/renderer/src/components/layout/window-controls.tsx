import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getDesktopBridge, getPlatform } from "@/platform/bridge";
import { cn } from "@/lib/utils";

export function WindowControls() {
    const { t } = useTranslation();
    const bridge = getDesktopBridge();
    const platform = getPlatform();
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        if (!bridge) return;
        let disposed = false;
        void bridge.windowControls.isMaximized().then((value) => {
            if (!disposed) setMaximized(value);
        });
        bridge.windowControls.onMaximizedChange((value) => setMaximized(value));
        return () => {
            disposed = true;
        };
    }, [bridge]);

    if (!bridge || platform === "darwin") return null;

    return (
        <div className="app-no-drag flex h-full shrink-0 items-stretch">
            <button
                type="button"
                onClick={() => void bridge.windowControls.minimize()}
                title={t("desktop.window.minimize")}
                aria-label={t("desktop.window.minimize")}
                className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
                <Minus className="size-3.5" />
            </button>
            <button
                type="button"
                onClick={() => void bridge.windowControls.toggleMaximize()}
                title={t(maximized ? "desktop.window.restore" : "desktop.window.maximize")}
                aria-label={t(maximized ? "desktop.window.restore" : "desktop.window.maximize")}
                className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
                {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
            </button>
            <button
                type="button"
                onClick={() => void bridge.windowControls.close()}
                title={t("desktop.window.close")}
                aria-label={t("desktop.window.close")}
                className={cn("grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white")}
            >
                <X className="size-3.5" />
            </button>
        </div>
    );
}
