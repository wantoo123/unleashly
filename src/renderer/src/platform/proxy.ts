import { DEFAULT_LOCAL_PROXY_URL, useConfigStore } from "@/stores/use-config-store";

import { getDesktopBridge } from "./bridge";
import { waitForConfigHydration } from "./config-ready";

const PROXY_INITIALIZED_KEY = "unleashly:proxy-initialized";

export async function configureDesktopProxy() {
    const bridge = getDesktopBridge();
    if (!bridge) return;

    const info = await bridge.proxy.info();
    if (!info.url) return;

    await waitForConfigHydration();
    const initialized = localStorage.getItem(PROXY_INITIALIZED_KEY) === "1";
    const state = useConfigStore.getState();

    if (!initialized) {
        useConfigStore.setState({ config: { ...state.config, proxyEnabled: true, proxyUrl: info.url } });
        localStorage.setItem(PROXY_INITIALIZED_KEY, "1");
        return;
    }

    // Keep the internal proxy address current between launches, but do not override
    // a proxy the user configured explicitly or re-enable one they disabled.
    if (state.config.proxyEnabled && (state.config.proxyUrl === DEFAULT_LOCAL_PROXY_URL || state.config.proxyUrl.startsWith("http://127.0.0.1:"))) {
        useConfigStore.setState({ config: { ...state.config, proxyUrl: info.url } });
    }
}
