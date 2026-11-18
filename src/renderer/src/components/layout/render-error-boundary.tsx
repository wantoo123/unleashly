import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, Download, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "antd";

import i18n from "@/i18n";
import { reportReactError } from "@/lib/error-reporting";
import { rendererLog } from "@/lib/renderer-logger";
import { exportDiagnosticsPackage, openLogDirectory } from "@/platform/diagnostics";

type RenderErrorBoundaryProps = {
    children: ReactNode;
};

type RenderErrorBoundaryState = {
    error: Error | null;
    componentStack: string;
    action: "" | "exporting" | "copied";
    actionError: string;
};

export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
    state: RenderErrorBoundaryState = {
        error: null,
        componentStack: "",
        action: "",
        actionError: "",
    };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        this.setState({ componentStack: info.componentStack || "" });
        rendererLog.error("React render error", { message: error.message, stack: error.stack, componentStack: info.componentStack || "" });
        reportReactError(error, info.componentStack || "");
    }

    private exportPackage = async () => {
        this.setState({ action: "exporting", actionError: "" });
        try {
            const result = await exportDiagnosticsPackage("react-error-boundary");
            if (!result.canceled) this.setState({ action: "", actionError: "" });
            else this.setState({ action: "" });
        } catch (error) {
            this.setState({ action: "", actionError: error instanceof Error ? error.message : String(error) });
        }
    };

    private copyError = async () => {
        const { error, componentStack } = this.state;
        const text = [error?.message, error?.stack, componentStack].filter(Boolean).join("\n\n");
        try {
            await navigator.clipboard.writeText(text);
            this.setState({ action: "copied" });
            window.setTimeout(() => this.setState({ action: "" }), 1500);
        } catch {
            this.setState({ actionError: i18n.t("diagnostics.errorBoundary.copyFailed") });
        }
    };

    render() {
        const { error, componentStack, action, actionError } = this.state;
        if (!error) return this.props.children;
        const details = [error.message, error.stack, componentStack].filter(Boolean).join("\n\n");

        return (
            <div className="flex min-h-dvh items-center justify-center overflow-y-auto bg-stone-50 p-6 dark:bg-stone-950">
                <div className="w-full max-w-2xl rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                    <div className="flex items-start gap-3">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-500">
                            <AlertTriangle className="size-5" />
                        </span>
                        <div className="min-w-0">
                            <h1 className="text-lg font-semibold text-stone-950 dark:text-stone-100">{i18n.t("diagnostics.errorBoundary.title")}</h1>
                            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">{i18n.t("diagnostics.errorBoundary.description")}</p>
                        </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">{error.message || i18n.t("diagnostics.errorBoundary.unknown")}</div>

                    <details className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
                        <summary className="cursor-pointer select-none font-medium">{i18n.t("diagnostics.errorBoundary.details")}</summary>
                        <pre className="thin-scrollbar mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words leading-5">{details}</pre>
                    </details>

                    {actionError ? <div className="mt-3 text-xs text-red-600 dark:text-red-300">{actionError}</div> : null}

                    <div className="mt-5 flex flex-wrap gap-2">
                        <Button type="primary" icon={<RotateCcw className="size-4" />} onClick={() => window.location.reload()}>
                            {i18n.t("diagnostics.errorBoundary.reload")}
                        </Button>
                        <Button icon={<Download className="size-4" />} loading={action === "exporting"} onClick={() => void this.exportPackage()}>
                            {i18n.t("diagnostics.exportPackage")}
                        </Button>
                        <Button icon={<FolderOpen className="size-4" />} onClick={() => void openLogDirectory()}>
                            {i18n.t("diagnostics.openLogs")}
                        </Button>
                        <Button icon={<Copy className="size-4" />} onClick={() => void this.copyError()}>
                            {action === "copied" ? i18n.t("diagnostics.errorBoundary.copied") : i18n.t("diagnostics.errorBoundary.copy")}
                        </Button>
                    </div>
                    <p className="mt-4 text-[11px] leading-5 text-stone-400">{i18n.t("diagnostics.errorBoundary.footer")}</p>
                </div>
            </div>
        );
    }
}
