import type { UnleashlyBridge } from "@shared/bridge";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";

import { getDesktopBridge } from "./bridge";
import { waitForConfigHydration } from "./config-ready";

const WEBDAV_SECRET_ID = "__webdav__";
const SECRET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

let ready = false;
let lastKeys = new Map<string, string>();
let lastWebdavPassword = "";
let queue: Promise<void> = Promise.resolve();

function validChannelId(id: string) {
    if (SECRET_ID_PATTERN.test(id)) return true;
    console.warn(`[secrets] Channel id "${id}" cannot be stored in the secret vault`);
    return false;
}

async function syncSecrets(bridge: UnleashlyBridge, channels: ModelChannel[], webdavPassword: string) {
    const next = new Map<string, string>();
    for (const channel of channels) {
        if (channel.apiKey && validChannelId(channel.id)) next.set(channel.id, channel.apiKey);
    }

    for (const [id, value] of next) {
        if (lastKeys.get(id) !== value) await bridge.secrets.set(id, value);
    }
    for (const id of lastKeys.keys()) {
        if (!next.has(id)) await bridge.secrets.remove(id);
    }
    lastKeys = next;

    if (webdavPassword !== lastWebdavPassword) {
        if (webdavPassword) await bridge.secrets.set(WEBDAV_SECRET_ID, webdavPassword);
        else await bridge.secrets.remove(WEBDAV_SECRET_ID);
        lastWebdavPassword = webdavPassword;
    }
}

export async function hydrateDesktopSecrets() {
    const bridge = getDesktopBridge();
    if (!bridge) return;

    await waitForConfigHydration();
    const state = useConfigStore.getState();
    const vault = await bridge.secrets.list();

    // Seed the vault from credentials that were loaded from the legacy store.
    for (const channel of state.config.channels) {
        if (!channel.apiKey || vault[channel.id] || !validChannelId(channel.id)) continue;
        try {
            await bridge.secrets.set(channel.id, channel.apiKey);
            vault[channel.id] = channel.apiKey;
        } catch (error) {
            console.warn("[secrets] Failed to migrate a channel API key", error);
        }
    }
    if (state.webdav.password && !vault[WEBDAV_SECRET_ID]) {
        try {
            await bridge.secrets.set(WEBDAV_SECRET_ID, state.webdav.password);
            vault[WEBDAV_SECRET_ID] = state.webdav.password;
        } catch (error) {
            console.warn("[secrets] Failed to migrate the WebDAV password", error);
        }
    }

    const channels = state.config.channels.map((channel) => ({ ...channel, apiKey: vault[channel.id] || channel.apiKey || "" }));
    const webdav = { ...state.webdav, password: vault[WEBDAV_SECRET_ID] || state.webdav.password || "" };
    useConfigStore.setState({ config: { ...state.config, channels }, webdav });

    lastKeys = new Map(channels.filter((channel) => channel.apiKey).map((channel) => [channel.id, channel.apiKey]));
    lastWebdavPassword = webdav.password;
    ready = true;

    useConfigStore.subscribe((next) => {
        if (!ready) return;
        const snapshotChannels = next.config.channels;
        const snapshotPassword = next.webdav.password;
        queue = queue.then(() => syncSecrets(bridge, snapshotChannels, snapshotPassword)).catch((error) => console.warn("[secrets] Failed to sync secrets", error));
    });
}
