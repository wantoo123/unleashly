import { useEffect, useRef } from "react";

import { useAgentStore } from "@/stores/use-agent-store";

/** Reconnect a previously configured local agent once per app session. */
export function useAgentAutoConnect() {
    const autoConnectRef = useRef(false);
    const token = useAgentStore((state) => state.token);
    const enabled = useAgentStore((state) => state.enabled);
    const connected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);

    useEffect(() => {
        if (autoConnectRef.current || enabled || connected || !token.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [connected, connectAgent, enabled, token]);
}
