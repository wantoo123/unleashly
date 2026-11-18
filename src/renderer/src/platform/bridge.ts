import type { UnleashlyBridge } from "@shared/bridge";

export function getDesktopBridge(): UnleashlyBridge | null {
    if (typeof window === "undefined") return null;
    return window.unleashly ?? null;
}

export function isDesktopRuntime() {
    return Boolean(getDesktopBridge());
}

export function getPlatform() {
    return getDesktopBridge()?.platform ?? "web";
}
