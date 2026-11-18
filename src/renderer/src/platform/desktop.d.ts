import type { UnleashlyBridge } from "@shared/bridge";

declare global {
    interface Window {
        unleashly?: UnleashlyBridge;
    }
}

export {};
