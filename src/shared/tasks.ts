/**
 * Shared contracts between the desktop renderer and the main-process Provider Gateway.
 *
 * The gateway owns all provider protocol details (OpenAI-compatible / Gemini) as well as
 * long-running task state. The renderer only sends normalized requests and receives
 * normalized results, which keeps credentials and retry policy out of the UI layer.
 */

export type TaskKind = "image" | "video" | "audio" | "text" | "model3d";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type TaskPriority = "low" | "normal" | "high";
export type GatewayApiFormat = "openai" | "gemini";

export type TaskErrorCode = "canceled" | "auth" | "rate_limit" | "timeout" | "network" | "server" | "not_found" | "invalid_request" | "invalid_response" | "content_policy" | "config" | "unsupported" | "interrupted" | "unknown";

export type TaskErrorInfo = {
    code: TaskErrorCode;
    message: string;
    status?: number;
    retryable: boolean;
};

/** A resolved channel credential snapshot. Only kept in main-process memory. */
export type ProviderTarget = {
    channelId: string;
    channelName?: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: GatewayApiFormat;
    model: string;
};

export type GatewayChannelModel = {
    name: string;
    capability: string;
    script?: string;
};

/** Channels synced from the renderer after the secret vault is hydrated. */
export type GatewayChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: GatewayApiFormat;
    models: GatewayChannelModel[];
};

export type TaskInput = {
    id?: string;
    kind: "image" | "video" | "audio";
    name: string;
    mimeType: string;
    /** Data URL used for transport. The main process moves it to a payload file before persisting. */
    dataUrl: string;
};

export type GatewayTextContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type GatewayTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | GatewayTextContent[];
};

export type ImageTaskRequest = {
    kind: "image";
    target: ProviderTarget;
    prompt: string;
    systemPrompt?: string;
    operation: "generate" | "edit";
    count: number;
    size?: string;
    quality?: string;
    background?: string;
    inputs?: TaskInput[];
};

export type VideoTaskRequest = {
    kind: "video";
    target: ProviderTarget;
    prompt: string;
    seconds: string;
    size?: string;
    resolution: string;
    ratio?: string;
    generateAudio: boolean;
    watermark: boolean;
    mode: "frames" | "reference";
    inputs?: TaskInput[];
};

export type AudioTaskRequest = {
    kind: "audio";
    target: ProviderTarget;
    prompt: string;
    voice: string;
    format: string;
    speed: string;
    instructions?: string;
};

export type TextTaskRequest = {
    kind: "text";
    target: ProviderTarget;
    messages: GatewayTextMessage[];
    systemPrompt?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
};

export type Model3DTaskRequest = {
    kind: "model3d";
    target: ProviderTarget;
    prompt: string;
    options?: Record<string, unknown>;
};

export type GatewayRequest = ImageTaskRequest | VideoTaskRequest | AudioTaskRequest | TextTaskRequest | Model3DTaskRequest;

export type EnqueueTaskRequest = {
    request: GatewayRequest;
    title?: string;
    priority?: TaskPriority;
    maxAttempts?: number;
    origin?: string;
    batchId?: string;
    /** Internal tasks (for example text streaming for canvas nodes) are hidden from the task center by default. */
    hidden?: boolean;
};

export type TaskUsage = {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    images?: number;
    videoSeconds?: number;
    audioSeconds?: number;
    characters?: number;
};

export type TaskRemoteState = {
    provider: "openai" | "gemini";
    id: string;
    model: string;
    pollCount: number;
    lastPolledAt?: number;
};

export type TaskResultItem = {
    index: number;
    kind: Exclude<TaskKind, "text">;
    mimeType: string;
    bytes: number;
    /** Relative to the task output directory; absent when the provider only returned a remote URL. */
    file?: string;
    url?: string;
    durationMs?: number;
};

export type TaskResultSummary = {
    itemCount: number;
    text?: string;
    items: TaskResultItem[];
    usage?: TaskUsage;
};

export type TaskRecord = {
    id: string;
    kind: TaskKind;
    status: TaskStatus;
    priority: TaskPriority;
    title: string;
    promptPreview: string;
    provider: Pick<ProviderTarget, "channelId" | "channelName" | "apiFormat" | "model">;
    /** A compact summary of request parameters, safe to show in the task center. */
    params: Record<string, unknown>;
    createdAt: number;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    attempts: number;
    maxAttempts: number;
    progress: number;
    phase?: string;
    usage?: TaskUsage;
    result?: TaskResultSummary;
    error?: TaskErrorInfo;
    remote?: TaskRemoteState;
    nextAttemptAt?: number;
    hidden?: boolean;
    origin?: string;
    batchId?: string;
};

export type TaskListFilter = {
    status?: TaskStatus | "active" | "all";
    kind?: TaskKind | "all";
    includeHidden?: boolean;
    limit?: number;
    offset?: number;
};

export type TaskKindStats = {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    canceled: number;
};

export type TaskStats = {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    canceled: number;
    successRate: number;
    averageDurationMs: number;
    totalDurationMs: number;
    usage: Required<Omit<TaskUsage, "inputTokens" | "outputTokens" | "totalTokens">> & { inputTokens: number; outputTokens: number; totalTokens: number };
    byKind: Record<TaskKind, TaskKindStats>;
    updatedAt: number;
};

export type TaskResultItemPayload = {
    index: number;
    kind: Exclude<TaskKind, "text">;
    mimeType: string;
    bytes: number;
    url?: string;
    dataUrl?: string;
    data?: ArrayBuffer;
    durationMs?: number;
};

export type TaskResultPayload = {
    task: TaskRecord;
    text?: string;
    items: TaskResultItemPayload[];
};

export type TaskConcurrency = {
    global: number;
    perKind: Record<TaskKind, number>;
};

export type TaskDeltaEvent = {
    taskId: string;
    text: string;
    delta: string;
};

export type TaskOpenEvent = {
    taskId?: string;
};

export const DEFAULT_TASK_CONCURRENCY: TaskConcurrency = {
    global: 3,
    perKind: { image: 2, video: 3, audio: 1, text: 2, model3d: 1 },
};

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
    image: "image",
    video: "video",
    audio: "audio",
    text: "text",
    model3d: "model3d",
};
