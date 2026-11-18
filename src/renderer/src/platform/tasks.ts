import type { GatewayChannel } from "@shared/tasks";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { getDesktopBridge } from "./bridge";
import { installTaskEvents } from "./task-events";

export function getTaskBridge() {
    return getDesktopBridge()?.tasks ?? null;
}

export function isTaskGatewayAvailable() {
    return Boolean(getTaskBridge());
}

function channelsForGateway(config: AiConfig): GatewayChannel[] {
    return config.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        models: channel.models.map((model) => ({ name: model.name, capability: model.capability })),
    }));
}

export async function syncGatewayChannels(config: AiConfig) {
    const bridge = getTaskBridge();
    if (!bridge) return;
    try {
        await bridge.syncChannels(channelsForGateway(config));
    } catch (error) {
        console.warn("[tasks] Failed to sync channels with the provider gateway", error);
    }
}

/**
 * Keep main-process channel credentials in sync with the renderer's in-memory config.
 * Only credentials that survived vault hydration are sent, and they never touch disk
 * on the gateway side.
 */
export function installGatewayChannelSync() {
    if (!isTaskGatewayAvailable()) return;
    installTaskEvents();
    void syncGatewayChannels(useConfigStore.getState().config);
    useConfigStore.subscribe((state, previous) => {
        if (state.config.channels === previous.config.channels) return;
        void syncGatewayChannels(state.config);
    });
}
