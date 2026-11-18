import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { bootstrapDesktop } from "@/platform/bootstrap";
import { isDesktopRuntime } from "@/platform/bridge";
import { installGlobalErrorReporting, reportRendererCrash } from "@/lib/error-reporting";

async function start() {
    installGlobalErrorReporting();
    try {
        await bootstrapDesktop();
        await import("@/i18n");

        const [{ AppProviders }, { router }, { initAnalytics }, { RenderErrorBoundary }] = await Promise.all([
            import("@/components/layout/app-providers"),
            import("@/router"),
            import("@/lib/analytics"),
            import("@/components/layout/render-error-boundary"),
        ]);
        if (!isDesktopRuntime()) initAnalytics();

        document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

        createRoot(document.getElementById("root")!).render(
            <React.StrictMode>
                <RenderErrorBoundary>
                    <AppProviders>
                        <RouterProvider router={router} />
                    </AppProviders>
                </RenderErrorBoundary>
            </React.StrictMode>,
        );
        document.getElementById("boot")?.remove();
    } catch (error) {
        console.error("[boot] Failed to start Unleashly", error);
        reportRendererCrash({
            kind: "renderer-bootstrap-error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });
        const boot = document.getElementById("boot");
        if (!boot) return;
        boot.classList.add("boot-error");
        const title = boot.querySelector(".boot-title");
        const message = boot.querySelector(".boot-message");
        if (title) title.textContent = "启动失败";
        if (message) message.textContent = error instanceof Error ? error.message : String(error);
    }
}

void start();
