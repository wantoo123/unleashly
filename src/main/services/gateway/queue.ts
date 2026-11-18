import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type {
    EnqueueTaskRequest,
    GatewayChannel,
    GatewayRequest,
    ProviderTarget,
    TaskConcurrency,
    TaskDeltaEvent,
    TaskErrorInfo,
    TaskKind,
    TaskListFilter,
    TaskRecord,
    TaskResultItem,
    TaskResultPayload,
    TaskResultSummary,
    TaskStats,
    TaskStatus,
    TaskUsage,
} from "@shared/tasks";
import { DEFAULT_TASK_CONCURRENCY } from "@shared/tasks";

import { ProviderError, assertConfigured, fromUnknownError, toTaskError } from "./errors";
import { requestSummary, requestPrompt, runProvider } from "./index";
import type { ProviderContext, ProviderRunResult, ResolvedInput } from "./types";

const TASK_ID_PATTERN = /^task_[A-Za-z0-9-]{8,}$/;
const RETENTION_LIMIT = 300;
const PROGRESS_SAVE_INTERVAL_MS = 2000;

type StoredInputFile = {
    index: number;
    // Relative to the task payload directory, e.g. "inputs/0.png".
    file: string;
    kind: ResolvedInput["kind"];
    name: string;
    mimeType: string;
};

type StoredPayload = {
    request: GatewayRequest;
    inputFiles: StoredInputFile[];
};

type StoredQueue = {
    version: 1;
    concurrency: TaskConcurrency;
    tasks: TaskRecord[];
};

type TaskQueueOptions = {
    dir: string;
    log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    /** Injectable provider runner for tests and future alternate gateways. */
    runner?: (request: GatewayRequest, inputs: ResolvedInput[], context: ProviderContext) => Promise<ProviderRunResult>;
    onChanged?: (task: TaskRecord) => void;
    onDelta?: (event: TaskDeltaEvent) => void;
    onFinished?: (task: TaskRecord) => void;
    onActiveCountChanged?: (count: number) => void;
};

function now() {
    return Date.now();
}

function clampConcurrency(value: unknown, fallback: number) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : fallback;
}

function cloneTask(task: TaskRecord): TaskRecord {
    return structuredClone(task);
}

function sanitizeTarget(target: ProviderTarget): ProviderTarget {
    return { ...target, apiKey: "" };
}

function mimeExtension(mimeType: string) {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim() || "";
    if (subtype === "mpeg") return "mp3";
    if (subtype === "quicktime") return "mov";
    if (subtype === "jpeg") return "jpg";
    if (subtype === "svg+xml") return "svg";
    if (subtype === "x-matroska") return "mkv";
    if (subtype === "plain") return "txt";
    return subtype.replace(/[^a-z0-9]/gi, "") || "bin";
}

function decodeDataUrl(dataUrl: string) {
    const match = dataUrl.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!match) throw new ProviderError("invalid_request", "Invalid reference data URL", { retryable: false });
    const mimeType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || "";
    const data = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (!data.length) throw new ProviderError("invalid_request", "Reference file is empty", { retryable: false });
    return { mimeType, data };
}

function promptTitle(request: GatewayRequest) {
    const prompt = requestPrompt(request).trim();
    return prompt.slice(0, 40) || `${request.kind} task`;
}

function promptPreview(request: GatewayRequest) {
    return requestPrompt(request).trim().slice(0, 240);
}

function providerRecord(target: ProviderTarget): TaskRecord["provider"] {
    return { channelId: target.channelId, channelName: target.channelName, apiFormat: target.apiFormat, model: target.model };
}

function defaultMaxAttempts(kind: TaskKind) {
    // Image generations can be expensive and a lost response may still have billed,
    // so automatic retry is opt-in for images while long-running tasks retry once.
    return kind === "image" ? 1 : 2;
}

function retryDelayMs(attempts: number) {
    return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 500);
}

function emptyKindStats() {
    return { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
}

export class TaskQueue {
    private readonly dir: string;
    private readonly tasks = new Map<string, TaskRecord>();
    private readonly controllers = new Map<string, AbortController>();
    private readonly runningKinds = new Map<string, TaskKind>();
    private readonly liveTargets = new Map<string, ProviderTarget>();
    private readonly channels = new Map<string, GatewayChannel>();
    private readonly lastProgressSave = new Map<string, number>();
    private readonly executions = new Map<string, Promise<void>>();
    private readonly options: TaskQueueOptions;
    private concurrency: TaskConcurrency = structuredClone(DEFAULT_TASK_CONCURRENCY);
    private writeChain: Promise<void> = Promise.resolve();
    private pumpTimer: NodeJS.Timeout | null = null;
    private pumpScheduled = false;
    private initialized = false;
    private shuttingDown = false;

    constructor(options: TaskQueueOptions) {
        this.options = options;
        this.dir = options.dir;
    }

    private get tasksFile() {
        return join(this.dir, "tasks.json");
    }

    private payloadDir(taskId: string) {
        return join(this.dir, "payloads", taskId);
    }

    private outputDir(taskId: string) {
        return join(this.dir, "outputs", taskId);
    }

    async init() {
        if (this.initialized) return;
        await mkdir(this.dir, { recursive: true });
        const stored = await this.readStoredQueue();
        if (stored) {
            this.concurrency = {
                global: clampConcurrency(stored.concurrency?.global, DEFAULT_TASK_CONCURRENCY.global),
                perKind: {
                    image: clampConcurrency(stored.concurrency?.perKind?.image, DEFAULT_TASK_CONCURRENCY.perKind.image),
                    video: clampConcurrency(stored.concurrency?.perKind?.video, DEFAULT_TASK_CONCURRENCY.perKind.video),
                    audio: clampConcurrency(stored.concurrency?.perKind?.audio, DEFAULT_TASK_CONCURRENCY.perKind.audio),
                    text: clampConcurrency(stored.concurrency?.perKind?.text, DEFAULT_TASK_CONCURRENCY.perKind.text),
                    model3d: clampConcurrency(stored.concurrency?.perKind?.model3d, DEFAULT_TASK_CONCURRENCY.perKind.model3d),
                },
            };
            for (const task of stored.tasks || []) {
                if (!task?.id || !TASK_ID_PATTERN.test(task.id)) continue;
                this.tasks.set(task.id, this.recoverTask(task));
            }
        }
        this.initialized = true;
        await this.persist();
        this.emitActiveCount();
        this.pump();
    }

    private recoverTask(task: TaskRecord): TaskRecord {
        if (task.status === "running") {
            // Video jobs have a provider-side task id, so polling can continue after a restart.
            if (task.kind === "video" && task.remote?.id) {
                return {
                    ...task,
                    status: "queued",
                    phase: "resuming",
                    progress: Math.min(task.progress || 0, 0.1),
                    nextAttemptAt: now(),
                    error: undefined,
                };
            }
            return {
                ...task,
                status: "failed",
                phase: "interrupted",
                progress: 0,
                finishedAt: now(),
                error: { code: "interrupted", message: "The app restarted before this task finished", retryable: false },
            };
        }
        return task;
    }

    private async readStoredQueue(): Promise<StoredQueue | null> {
        try {
            const parsed = JSON.parse(await readFile(this.tasksFile, "utf8")) as Partial<StoredQueue>;
            if (!parsed || !Array.isArray(parsed.tasks)) return null;
            return { version: 1, concurrency: parsed.concurrency as TaskConcurrency, tasks: parsed.tasks as TaskRecord[] };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.log?.warn("Failed to read task queue", error);
            return null;
        }
    }

    private async persist() {
        const snapshot: StoredQueue = {
            version: 1,
            concurrency: this.concurrency,
            tasks: Array.from(this.tasks.values()),
        };
        this.writeChain = this.writeChain.then(async () => {
            await mkdir(this.dir, { recursive: true });
            const temp = `${this.tasksFile}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(temp, JSON.stringify(snapshot), "utf8");
            await rename(temp, this.tasksFile);
        });
        try {
            await this.writeChain;
        } catch (error) {
            this.options.log?.error("Failed to persist task queue", error);
        }
    }

    private emitChanged(task: TaskRecord) {
        this.options.onChanged?.(cloneTask(task));
    }

    private emitActiveCount() {
        this.options.onActiveCountChanged?.(this.activeCount());
    }

    activeCount() {
        return this.runningKinds.size;
    }

    hasActiveTasks() {
        return this.activeCount() > 0 || Array.from(this.tasks.values()).some((task) => task.status === "queued");
    }

    syncChannels(channels: GatewayChannel[]) {
        this.channels.clear();
        for (const channel of channels || []) {
            if (!channel?.id) continue;
            this.channels.set(channel.id, channel);
        }
        this.pump();
    }

    private resolveTarget(task: TaskRecord) {
        const channel = this.channels.get(task.provider.channelId);
        const live = this.liveTargets.get(task.id);
        if (channel && channel.apiKey.trim()) {
            return {
                channelId: channel.id,
                channelName: channel.name,
                baseUrl: channel.baseUrl,
                apiKey: channel.apiKey,
                apiFormat: channel.apiFormat,
                model: task.provider.model,
            } satisfies ProviderTarget;
        }
        if (live) return live;
        if (channel) {
            return {
                channelId: channel.id,
                channelName: channel.name,
                baseUrl: channel.baseUrl,
                apiKey: channel.apiKey,
                apiFormat: channel.apiFormat,
                model: task.provider.model,
            } satisfies ProviderTarget;
        }
        return null;
    }

    private isTargetReady(task: TaskRecord) {
        const target = this.resolveTarget(task);
        return Boolean(target && target.baseUrl.trim() && target.apiKey.trim());
    }

    async enqueue(input: EnqueueTaskRequest): Promise<TaskRecord> {
        if (!this.initialized) await this.init();
        const request = input.request;
        if (!request || typeof request !== "object" || !request.target) throw new ProviderError("invalid_request", "Invalid task request", { retryable: false });
        assertConfigured(request.target, { modelRequired: true });
        const id = `task_${randomUUID()}`;
        const timestamp = now();
        const target = request.target;
        const sanitizedTarget = sanitizeTarget(target);
        const sanitizedRequest: GatewayRequest = { ...request, target: sanitizedTarget } as GatewayRequest;
        const inputFiles = await this.storePayload(id, sanitizedRequest);
        const task: TaskRecord = {
            id,
            kind: request.kind,
            status: "queued",
            priority: input.priority || "normal",
            title: input.title?.trim() || promptTitle(request),
            promptPreview: promptPreview(request),
            provider: providerRecord(sanitizedTarget),
            params: requestSummary(request),
            createdAt: timestamp,
            queuedAt: timestamp,
            attempts: 0,
            maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? defaultMaxAttempts(request.kind))),
            progress: 0,
            phase: "queued",
            ...(input.hidden ? { hidden: true } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
            ...(input.batchId ? { batchId: input.batchId } : {}),
        };
        this.tasks.set(id, task);
        this.liveTargets.set(id, target);
        if (inputFiles.length) {
            // Keep payload metadata alongside the stored request for diagnostics.
            await writeFile(join(this.payloadDir(id), "manifest.json"), JSON.stringify(inputFiles), "utf8");
        }
        await this.persist();
        this.emitChanged(task);
        this.pump();
        return cloneTask(task);
    }

    private async storePayload(taskId: string, request: GatewayRequest): Promise<StoredInputFile[]> {
        const dir = this.payloadDir(taskId);
        await mkdir(dir, { recursive: true });
        const inputs = "inputs" in request ? request.inputs || [] : [];
        const inputFiles: StoredInputFile[] = [];
        const decodedInputs = inputs.map((input, index) => {
            const { mimeType, data } = decodeDataUrl(input.dataUrl);
            const extension = mimeExtension(mimeType);
            inputFiles.push({ index, file: `inputs/${index}.${extension}`, kind: input.kind, name: input.name || `input-${index}`, mimeType: mimeType || input.mimeType });
            return { dataUrl: "", mimeType: mimeType || input.mimeType, name: input.name || `input-${index}`, kind: input.kind };
        });
        if (decodedInputs.length) await mkdir(join(dir, "inputs"), { recursive: true });
        for (const [index, input] of inputs.entries()) {
            const { data } = decodeDataUrl(input.dataUrl);
            await writeFile(join(dir, inputFiles[index].file), data);
        }
        const stored: StoredPayload = {
            request: { ...request, inputs: inputs.map((input, index) => ({ ...input, ...decodedInputs[index] })) } as GatewayRequest,
            inputFiles,
        };
        await writeFile(join(dir, "request.json"), JSON.stringify(stored), "utf8");
        return inputFiles;
    }

    private async loadPayload(taskId: string): Promise<{ request: GatewayRequest; inputs: ResolvedInput[] }> {
        const dir = this.payloadDir(taskId);
        const stored = JSON.parse(await readFile(join(dir, "request.json"), "utf8")) as StoredPayload;
        const inputs = await Promise.all(
            (stored.inputFiles || []).map(async (file) => ({
                index: file.index,
                kind: file.kind,
                name: file.name,
                mimeType: file.mimeType,
                data: await readFile(join(dir, file.file)),
            })),
        );
        return { request: stored.request, inputs };
    }

    private async execute(task: TaskRecord) {
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        this.runningKinds.set(task.id, task.kind);
        task.status = "running";
        task.startedAt = task.startedAt || now();
        task.attempts += 1;
        task.progress = task.progress || 0;
        task.phase = task.remote ? "resuming" : "starting";
        task.error = undefined;
        task.nextAttemptAt = undefined;
        this.emitChanged(task);
        this.emitActiveCount();
        await this.persist();

        let lastText = "";
        let lastProgressSave = 0;
        try {
            const target = this.resolveTarget(task);
            if (!target) throw new ProviderError("config", `Channel ${task.provider.channelName || task.provider.channelId} is not available`, { retryable: false });
            if (!target.baseUrl.trim() || !target.apiKey.trim()) throw new ProviderError("config", "Channel credentials are not configured", { retryable: false });
            const payload = await this.loadPayload(task.id);
            if (controller.signal.aborted) throw new ProviderError("canceled", "Task canceled before it started", { retryable: false });
            const request = { ...payload.request, target } as GatewayRequest;
            const context: ProviderContext = {
                signal: controller.signal,
                remote: task.remote ? { provider: task.remote.provider, id: task.remote.id, model: task.remote.model } : undefined,
                onRemote: (remote) => {
                    task.remote = { ...remote, pollCount: 0 };
                    this.emitChanged(task);
                    void this.persist();
                },
                onProgress: (progress, phase) => {
                    task.progress = Math.max(0, Math.min(1, progress));
                    if (phase) task.phase = phase;
                    this.emitChanged(task);
                    const timestamp = now();
                    if (timestamp - lastProgressSave > PROGRESS_SAVE_INTERVAL_MS) {
                        lastProgressSave = timestamp;
                        void this.persist();
                    }
                },
                onDelta: (text) => {
                    const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
                    lastText = text;
                    if (delta) this.options.onDelta?.({ taskId: task.id, text, delta });
                },
            };
            const result = await (this.options.runner || runProvider)(request, payload.inputs, context);
            if (this.tasks.get(task.id)?.status === "canceled") return;
            await this.completeTask(task, result);
        } catch (error) {
            this.handleFailure(task, error);
        } finally {
            this.controllers.delete(task.id);
            this.runningKinds.delete(task.id);
            this.lastProgressSave.delete(task.id);
            this.emitActiveCount();
            this.pump();
        }
    }

    private async completeTask(task: TaskRecord, result: ProviderRunResult) {
        if (!this.tasks.has(task.id) || task.status === "canceled") return;
        const items = await this.storeOutputs(task.id, result, task.kind);
        const summary: TaskResultSummary = {
            itemCount: items.length,
            items,
            ...(result.text !== undefined ? { text: result.text } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
        };
        task.status = "succeeded";
        task.progress = 1;
        task.phase = "done";
        task.finishedAt = now();
        task.result = summary;
        task.usage = result.usage;
        task.error = undefined;
        task.nextAttemptAt = undefined;
        await this.persist();
        this.emitChanged(task);
        this.options.onFinished?.(cloneTask(task));
        await this.pruneRetention();
    }

    private async storeOutputs(taskId: string, result: ProviderRunResult, taskKind: TaskKind): Promise<TaskResultItem[]> {
        const dir = this.outputDir(taskId);
        const items: TaskResultItem[] = [];
        const itemKind = (mimeType: string): TaskResultItem["kind"] => {
            if (taskKind === "video" || mimeType.startsWith("video/")) return "video";
            if (taskKind === "audio" || mimeType.startsWith("audio/")) return "audio";
            if (taskKind === "model3d") return "model3d";
            return "image";
        };
        for (const [index, item] of result.items.entries()) {
            const mimeType =
                taskKind === "image" && !item.mimeType.startsWith("image/")
                    ? "image/png"
                    : taskKind === "video" && !item.mimeType.startsWith("video/")
                      ? "video/mp4"
                      : taskKind === "audio" && !item.mimeType.startsWith("audio/")
                        ? "audio/mpeg"
                        : item.mimeType;
            if (item.data) {
                await mkdir(dir, { recursive: true });
                const file = `${index}.${mimeExtension(mimeType)}`;
                await writeFile(join(dir, file), item.data);
                items.push({ index, kind: itemKind(mimeType), mimeType, bytes: item.data.length, file, ...(item.durationMs ? { durationMs: item.durationMs } : {}) });
            } else if (item.url) {
                items.push({ index, kind: itemKind(mimeType), mimeType, bytes: 0, url: item.url, ...(item.durationMs ? { durationMs: item.durationMs } : {}) });
            }
        }
        return items;
    }

    private handleFailure(task: TaskRecord, error: unknown) {
        if (!this.tasks.has(task.id)) return;
        if (this.tasks.get(task.id)?.status === "canceled") return;
        if (this.shuttingDown) {
            // Keep resumable provider-side tasks for the next launch instead of
            // marking them canceled just because the app is quitting.
            if (task.kind === "video" && task.remote?.id) {
                task.status = "queued";
                task.phase = "resuming";
                task.progress = Math.min(task.progress, 0.1);
                task.nextAttemptAt = now();
                task.error = undefined;
            } else {
                task.status = "failed";
                task.phase = "interrupted";
                task.finishedAt = now();
                task.error = { code: "interrupted", message: "The app quit before this task finished", retryable: false };
            }
            void this.persist();
            return;
        }
        const info: TaskErrorInfo = error instanceof ProviderError && error.code === "canceled" ? { code: "canceled", message: error.message, retryable: false } : toTaskError(error);
        if (info.code === "canceled") {
            task.status = "canceled";
            task.phase = "canceled";
            task.finishedAt = now();
            task.error = info;
            void this.persist();
            this.emitChanged(task);
            this.options.onFinished?.(cloneTask(task));
            return;
        }
        if (info.retryable && task.attempts < task.maxAttempts) {
            task.status = "queued";
            task.phase = "retry-wait";
            task.error = info;
            task.nextAttemptAt = now() + retryDelayMs(task.attempts);
            task.queuedAt = now();
            void this.persist();
            this.emitChanged(task);
            return;
        }
        task.status = "failed";
        task.phase = "failed";
        task.finishedAt = now();
        task.error = info;
        task.nextAttemptAt = undefined;
        void this.persist();
        this.emitChanged(task);
        this.options.onFinished?.(cloneTask(task));
        void this.pruneRetention();
    }

    private pump() {
        if (!this.initialized || this.shuttingDown || this.pumpScheduled) return;
        this.pumpScheduled = true;
        setImmediate(() => {
            this.pumpScheduled = false;
            this.pumpNow();
        });
    }

    private pumpNow() {
        if (this.shuttingDown) return;
        if (this.pumpTimer) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        if (this.activeCount() >= this.concurrency.global) return;
        const timestamp = now();
        const queued = Array.from(this.tasks.values())
            .filter((task) => task.status === "queued" && (!task.nextAttemptAt || task.nextAttemptAt <= timestamp) && this.isTargetReady(task))
            .sort((left, right) => priorityWeight(right.priority) - priorityWeight(left.priority) || left.queuedAt - right.queuedAt);

        let started = false;
        for (const task of queued) {
            if (this.activeCount() >= this.concurrency.global) break;
            const kindCount = Array.from(this.runningKinds.values()).filter((kind) => kind === task.kind).length;
            if (kindCount >= (this.concurrency.perKind[task.kind] || 1)) continue;
            started = true;
            const execution = this.execute(task);
            this.executions.set(task.id, execution);
            void execution.finally(() => this.executions.delete(task.id));
        }

        if (!started) {
            const future = Array.from(this.tasks.values())
                .filter((task) => task.status === "queued" && task.nextAttemptAt && task.nextAttemptAt > timestamp && this.isTargetReady(task))
                .map((task) => task.nextAttemptAt as number);
            if (future.length) {
                this.pumpTimer = setTimeout(() => this.pump(), Math.max(250, Math.min(...future) - timestamp));
            }
        }
    }

    async cancel(id: string): Promise<TaskRecord | null> {
        const task = this.tasks.get(id);
        if (!task) return null;
        if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") return cloneTask(task);
        task.status = "canceled";
        task.phase = "canceled";
        task.finishedAt = now();
        task.error = { code: "canceled", message: "Canceled by user", retryable: false };
        this.controllers.get(id)?.abort(new ProviderError("canceled", "Canceled by user", { retryable: false }));
        await this.persist();
        this.emitChanged(task);
        this.options.onFinished?.(cloneTask(task));
        this.pump();
        return cloneTask(task);
    }

    async retry(id: string): Promise<TaskRecord | null> {
        const task = this.tasks.get(id);
        if (!task || task.status === "running" || task.status === "queued") return task ? cloneTask(task) : null;
        task.status = "queued";
        task.phase = "queued";
        task.progress = 0;
        task.attempts = 0;
        task.startedAt = undefined;
        task.finishedAt = undefined;
        task.result = undefined;
        task.error = undefined;
        task.usage = undefined;
        task.remote = undefined;
        task.nextAttemptAt = now();
        task.queuedAt = now();
        await rm(this.outputDir(id), { recursive: true, force: true });
        await this.persist();
        this.emitChanged(task);
        this.pump();
        return cloneTask(task);
    }

    async remove(id: string): Promise<void> {
        const task = this.tasks.get(id);
        if (!task) return;
        if (task.status === "running") await this.cancel(id);
        this.tasks.delete(id);
        this.liveTargets.delete(id);
        await Promise.all([rm(this.payloadDir(id), { recursive: true, force: true }), rm(this.outputDir(id), { recursive: true, force: true })]);
        await this.persist();
        this.emitActiveCount();
    }

    async clearFinished(): Promise<number> {
        const finished = Array.from(this.tasks.values()).filter((task) => task.status === "succeeded" || task.status === "failed" || task.status === "canceled");
        for (const task of finished) {
            this.tasks.delete(task.id);
            this.liveTargets.delete(task.id);
            await Promise.all([rm(this.payloadDir(task.id), { recursive: true, force: true }), rm(this.outputDir(task.id), { recursive: true, force: true })]);
        }
        if (finished.length) await this.persist();
        return finished.length;
    }

    list(filter: TaskListFilter = {}) {
        const status = filter.status || "all";
        const kind = filter.kind || "all";
        const tasks = Array.from(this.tasks.values())
            .filter((task) => (filter.includeHidden ? true : !task.hidden))
            .filter((task) => (status === "all" ? true : status === "active" ? task.status === "queued" || task.status === "running" : task.status === status))
            .filter((task) => (kind === "all" ? true : task.kind === kind))
            .sort((left, right) => right.createdAt - left.createdAt);
        const offset = Math.max(0, Math.floor(filter.offset || 0));
        const limit = filter.limit === undefined ? tasks.length : Math.max(1, Math.floor(filter.limit));
        return tasks.slice(offset, offset + limit).map(cloneTask);
    }

    get(id: string) {
        const task = this.tasks.get(id);
        return task ? cloneTask(task) : null;
    }

    async getResult(id: string): Promise<TaskResultPayload | null> {
        const task = this.tasks.get(id);
        if (!task?.result) return null;
        const items: TaskResultPayload["items"] = [];
        for (const item of task.result.items) {
            if (item.url) {
                items.push({ index: item.index, kind: item.kind, mimeType: item.mimeType, bytes: item.bytes, url: item.url, ...(item.durationMs ? { durationMs: item.durationMs } : {}) });
                continue;
            }
            if (!item.file) continue;
            const data = await readFile(join(this.outputDir(id), item.file));
            if (item.kind === "image") {
                items.push({ index: item.index, kind: item.kind, mimeType: item.mimeType, bytes: item.bytes, dataUrl: `data:${item.mimeType};base64,${data.toString("base64")}`, ...(item.durationMs ? { durationMs: item.durationMs } : {}) });
            } else {
                const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
                items.push({ index: item.index, kind: item.kind, mimeType: item.mimeType, bytes: item.bytes, data: arrayBuffer, ...(item.durationMs ? { durationMs: item.durationMs } : {}) });
            }
        }
        return { task: cloneTask(task), text: task.result.text, items };
    }

    stats(): TaskStats {
        const tasks = Array.from(this.tasks.values()).filter((task) => !task.hidden);
        const stats: TaskStats = {
            total: tasks.length,
            queued: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
            canceled: 0,
            successRate: 0,
            averageDurationMs: 0,
            totalDurationMs: 0,
            usage: { images: 0, videoSeconds: 0, audioSeconds: 0, characters: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            byKind: { image: emptyKindStats(), video: emptyKindStats(), audio: emptyKindStats(), text: emptyKindStats(), model3d: emptyKindStats() },
            updatedAt: now(),
        };
        let finished = 0;
        let succeededOrFailed = 0;
        let durationTotal = 0;
        for (const task of tasks) {
            stats[task.status] += 1;
            stats.byKind[task.kind].total += 1;
            stats.byKind[task.kind][task.status] += 1;
            if (task.usage) {
                stats.usage.images += task.usage.images || 0;
                stats.usage.videoSeconds += task.usage.videoSeconds || 0;
                stats.usage.audioSeconds += task.usage.audioSeconds || 0;
                stats.usage.characters += task.usage.characters || 0;
                stats.usage.inputTokens += task.usage.inputTokens || 0;
                stats.usage.outputTokens += task.usage.outputTokens || 0;
                stats.usage.totalTokens += task.usage.totalTokens || 0;
            }
            if (task.status === "succeeded" || task.status === "failed") {
                succeededOrFailed += 1;
                if (task.status === "succeeded") finished += 1;
                if (task.startedAt && task.finishedAt) {
                    durationTotal += Math.max(0, task.finishedAt - task.startedAt);
                    stats.totalDurationMs += Math.max(0, task.finishedAt - task.startedAt);
                }
            }
        }
        stats.successRate = succeededOrFailed ? finished / succeededOrFailed : 0;
        stats.averageDurationMs = succeededOrFailed ? Math.round(durationTotal / succeededOrFailed) : 0;
        return stats;
    }

    getConcurrency(): TaskConcurrency {
        return structuredClone(this.concurrency);
    }

    async setConcurrency(update: Partial<TaskConcurrency> & { perKind?: Partial<TaskConcurrency["perKind"]> }): Promise<TaskConcurrency> {
        this.concurrency = {
            global: clampConcurrency(update.global ?? this.concurrency.global, this.concurrency.global),
            perKind: {
                image: clampConcurrency(update.perKind?.image ?? this.concurrency.perKind.image, this.concurrency.perKind.image),
                video: clampConcurrency(update.perKind?.video ?? this.concurrency.perKind.video, this.concurrency.perKind.video),
                audio: clampConcurrency(update.perKind?.audio ?? this.concurrency.perKind.audio, this.concurrency.perKind.audio),
                text: clampConcurrency(update.perKind?.text ?? this.concurrency.perKind.text, this.concurrency.perKind.text),
                model3d: clampConcurrency(update.perKind?.model3d ?? this.concurrency.perKind.model3d, this.concurrency.perKind.model3d),
            },
        };
        await this.persist();
        this.pump();
        return this.getConcurrency();
    }

    private async pruneRetention() {
        const finished = Array.from(this.tasks.values())
            .filter((task) => task.status === "succeeded" || task.status === "failed" || task.status === "canceled")
            .sort((left, right) => right.createdAt - left.createdAt);
        for (const task of finished.slice(RETENTION_LIMIT)) {
            this.tasks.delete(task.id);
            this.liveTargets.delete(task.id);
            await Promise.all([rm(this.payloadDir(task.id), { recursive: true, force: true }), rm(this.outputDir(task.id), { recursive: true, force: true })]);
        }
        if (finished.length > RETENTION_LIMIT) await this.persist();
    }

    async shutdown() {
        this.shuttingDown = true;
        if (this.pumpTimer) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        for (const controller of this.controllers.values()) controller.abort(new ProviderError("canceled", "Application is quitting", { retryable: false }));
        // Give in-flight executions a moment to persist their interrupted/resumable state.
        await Promise.race([Promise.allSettled(Array.from(this.executions.values())), new Promise((resolve) => setTimeout(resolve, 3000))]);
        await this.persist();
    }
}

function priorityWeight(priority: TaskRecord["priority"]) {
    return priority === "high" ? 3 : priority === "low" ? 1 : 2;
}
