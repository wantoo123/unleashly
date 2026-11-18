import { getDesktopBridge } from "./bridge";
import { bootstrapDesktopStorage } from "./storage/bootstrap";

export async function bootstrapDesktop() {
    if (!getDesktopBridge()) return;

    await bootstrapDesktopStorage();

    const [{ configureDesktopProxy }, { hydrateDesktopSecrets }, { installGatewayChannelSync }] = await Promise.all([import("./proxy"), import("./secrets"), import("./tasks")]);
    await configureDesktopProxy();
    await hydrateDesktopSecrets();
    installGatewayChannelSync();
}
