import { useConfigStore } from "@/stores/use-config-store";

export async function waitForConfigHydration() {
    if (useConfigStore.persist.hasHydrated()) return;
    await new Promise<void>((resolve) => {
        const unsubscribe = useConfigStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
    });
}
