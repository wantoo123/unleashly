import type { GatewayRequest, TaskKind } from "@shared/tasks";

import { ProviderError } from "./errors";
import { audioProgressSummary, runAudioProvider } from "./providers/audio";
import { imageProgressSummary, runImageProvider } from "./providers/image";
import { runTextProvider, textProgressSummary } from "./providers/text";
import { runVideoProvider, videoProgressSummary } from "./providers/video";
import type { ProviderContext, ProviderRunResult, ResolvedInput } from "./types";

export function requestKind(request: GatewayRequest): TaskKind {
    return request.kind;
}

export function requestPrompt(request: GatewayRequest) {
    if (request.kind === "text") {
        const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
        const content = lastUser?.content;
        if (typeof content === "string") return content;
        return content?.map((item) => (item.type === "text" ? item.text : "[image]")).join(" ") || "";
    }
    return request.prompt;
}

export function requestSummary(request: GatewayRequest): Record<string, unknown> {
    switch (request.kind) {
        case "image":
            return imageProgressSummary(request);
        case "video":
            return videoProgressSummary(request);
        case "audio":
            return audioProgressSummary(request);
        case "text":
            return textProgressSummary(request);
        case "model3d":
            return { options: request.options || {} };
    }
}

export async function runProvider(request: GatewayRequest, inputs: ResolvedInput[], ctx: ProviderContext): Promise<ProviderRunResult> {
    switch (request.kind) {
        case "image":
            return runImageProvider(request, inputs, ctx);
        case "video":
            return runVideoProvider(request, inputs, ctx);
        case "audio":
            return runAudioProvider(request, ctx);
        case "text":
            return runTextProvider(request, ctx);
        case "model3d":
            throw new ProviderError("unsupported", "3D generation providers are not implemented yet", { retryable: false });
        default:
            throw new ProviderError("unsupported", "Unsupported task kind", { retryable: false });
    }
}
