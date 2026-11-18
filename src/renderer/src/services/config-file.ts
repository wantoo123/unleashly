import i18n from "@/i18n";
import { isDesktopRuntime } from "@/platform/bridge";
import { saveFile } from "@/platform/files";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export async function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const desktop = isDesktopRuntime();
    const exportedConfig: AiConfig = desktop ? { ...config, apiKey: "", channels: config.channels.map((channel) => ({ ...channel, apiKey: "" })) } : config;
    const exportedWebdav: WebdavSyncConfig = desktop ? { ...webdav, password: "" } : webdav;
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config: exportedConfig, webdav: exportedWebdav, promptSources: { sources, schedule } };
    await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), desktop ? "unleashly-config.json" : "infinite-canvas-config.json", [{ name: "JSON", extensions: ["json"] }]);
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) throw new Error(i18n.t("config.invalidFile"));
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    usePromptSourceStore.setState(data.promptSources);
}
