import type { TaskUsage } from "@shared/tasks";

export type ResolvedInput = {
    index: number;
    kind: "image" | "video" | "audio";
    name: string;
    mimeType: string;
    data: Buffer;
};

export type ProviderContext = {
    signal: AbortSignal;
    onProgress?: (progress: number, phase?: string) => void;
    onDelta?: (text: string) => void;
    onRemote?: (remote: { provider: "openai" | "gemini"; id: string; model: string }) => void;
    remote?: { provider: "openai" | "gemini"; id: string; model: string };
};

export type BinaryOutput = {
    data?: Buffer;
    url?: string;
    mimeType: string;
    durationMs?: number;
};

export type ProviderRunResult = {
    items: BinaryOutput[];
    text?: string;
    usage?: TaskUsage;
    remote?: { provider: "openai" | "gemini"; id: string; model: string };
};
