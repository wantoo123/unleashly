import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskQueue } from "../src/main/services/gateway/queue";
import type { EnqueueTaskRequest, GatewayRequest, TaskKind, TaskRecord } from "../src/shared/tasks";

const createdDirs: string[] = [];

afterEach(async () => {
    await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    createdDirs.length = 0;
});

async function createQueue(options: Partial<ConstructorParameters<typeof TaskQueue>[0]> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "unleashly-queue-"));
    createdDirs.push(dir);
    const queue = new TaskQueue({ dir, ...options });
    await queue.init();
    return queue;
}

function target() {
    return { channelId: "test-channel", channelName: "Test", baseUrl: "https://api.example.test", apiKey: "secret", apiFormat: "openai" as const, model: "test-model" };
}

function textRequest(prompt: string): GatewayRequest {
    return { kind: "text", target: target(), messages: [{ role: "user", content: prompt }] };
}

function imageRequest(): GatewayRequest {
    return { kind: "image", target: target(), prompt: "draw a cat", operation: "generate", count: 1 };
}

function videoRequest(): GatewayRequest {
    return { kind: "video", target: target(), prompt: "waves", seconds: "4", size: "16:9", resolution: "720", generateAudio: false, watermark: false, mode: "frames" };
}

function enqueueText(prompt: string, extra: Partial<EnqueueTaskRequest> = {}): EnqueueTaskRequest {
    return { request: textRequest(prompt), ...extra };
}

async function waitForTask(queue: TaskQueue, id: string, timeoutMs = 10_000): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const task = queue.get(id);
        if (task && (task.status === "succeeded" || task.status === "failed" || task.status === "canceled")) return task;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for task ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("runs a task, persists its text result, and reports stats", async () => {
    const queue = await createQueue({
        runner: async (request, _inputs, ctx) => {
            const text = `echo:${request.kind}:${(request as { messages: Array<{ content: string }> }).messages[0].content}`;
            ctx.onDelta?.(text);
            return { items: [], text, usage: { totalTokens: 7 } };
        },
    });
    const task = await queue.enqueue(enqueueText("hello"));
    const finished = await waitForTask(queue, task.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.phase).toBe("done");
    const result = await queue.getResult(task.id);
    expect(result?.text).toBe("echo:text:hello");
    const stats = queue.stats();
    expect(stats.total).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.successRate).toBe(1);
    expect(stats.usage.totalTokens).toBe(7);
    await queue.shutdown();
});

test("stores binary outputs and can return them as data URLs", async () => {
    const queue = await createQueue({
        runner: async () => ({ items: [{ data: Buffer.from([1, 2, 3, 4]), mimeType: "image/png" }], usage: { images: 1 } }),
    });
    const task = await queue.enqueue({ request: imageRequest(), origin: "test" });
    const finished = await waitForTask(queue, task.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.result?.items[0].file).toBe("0.png");
    const result = await queue.getResult(task.id);
    expect(result?.items[0].dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    expect(queue.stats().usage.images).toBe(1);
    await queue.shutdown();
});

test("respects priority order and global concurrency", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = await createQueue({
        runner: async (request) => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            const prompt = (request as { messages: Array<{ content: string }> }).messages[0].content;
            order.push(prompt);
            if (order.length === 1) await firstGate;
            concurrent -= 1;
            return { items: [], text: prompt };
        },
    });
    await queue.setConcurrency({ global: 1 });
    const low = await queue.enqueue(enqueueText("low", { priority: "low" }));
    const high = await queue.enqueue(enqueueText("high", { priority: "high" }));
    const normal = await queue.enqueue(enqueueText("normal", { priority: "normal" }));
    const orderDeadline = Date.now() + 5000;
    while (!order.length && Date.now() < orderDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["low"]);
    releaseFirst();
    await waitForTask(queue, low.id);
    await waitForTask(queue, high.id);
    await waitForTask(queue, normal.id);
    expect(order).toEqual(["low", "high", "normal"]);
    expect(maxConcurrent).toBe(1);
    await queue.shutdown();
});

test("cancels a running task and abort its provider call", async () => {
    const queue = await createQueue({
        runner: (_request, _inputs, ctx) =>
            new Promise((_resolve, reject) => {
                ctx.signal.addEventListener(
                    "abort",
                    () => {
                        const error = new Error("aborted");
                        error.name = "AbortError";
                        reject(error);
                    },
                    { once: true },
                );
            }),
    });
    const task = await queue.enqueue(enqueueText("cancel me"));
    const deadline = Date.now() + 5000;
    while (queue.get(task.id)?.status !== "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queue.get(task.id)?.status).toBe("running");
    const canceled = await queue.cancel(task.id);
    expect(canceled?.status).toBe("canceled");
    expect(queue.activeCount()).toBe(0);
    await queue.shutdown();
});

test("recovers queued work after a restart and marks interrupted tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unleashly-queue-"));
    createdDirs.push(dir);
    const blocking = new TaskQueue({
        dir,
        runner: (_request, _inputs, ctx) =>
            new Promise((_resolve, reject) => {
                ctx.signal.addEventListener(
                    "abort",
                    () => {
                        const error = new Error("aborted");
                        error.name = "AbortError";
                        reject(error);
                    },
                    { once: true },
                );
            }),
    });
    await blocking.init();
    await blocking.setConcurrency({ global: 1 });
    const first = await blocking.enqueue(enqueueText("first"));
    const second = await blocking.enqueue(enqueueText("second"));
    const deadline = Date.now() + 5000;
    while (blocking.get(first.id)?.status !== "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await blocking.shutdown();
    expect(blocking.get(first.id)?.status).toBe("failed");
    expect(blocking.get(first.id)?.error?.code).toBe("interrupted");
    expect(blocking.get(second.id)?.status).toBe("queued");

    const recovered = new TaskQueue({ dir, runner: async (request) => ({ items: [], text: (request as { messages: Array<{ content: string }> }).messages[0].content }) });
    await recovered.init();
    recovered.syncChannels([{ id: "test-channel", name: "Test", baseUrl: "https://api.example.test", apiKey: "secret", apiFormat: "openai", models: [{ name: "test-model", capability: "text" }] }]);
    const finished = await waitForTask(recovered, second.id);
    expect(finished.status).toBe("succeeded");
    await recovered.shutdown();
});

test("keeps video tasks resumable across a graceful shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unleashly-queue-"));
    createdDirs.push(dir);
    const blocking = new TaskQueue({
        dir,
        runner: async (_request, _inputs, ctx) => {
            ctx.onRemote?.({ provider: "openai", id: "remote-video-1", model: "test-model" });
            return new Promise((_resolve, reject) => {
                ctx.signal.addEventListener(
                    "abort",
                    () => {
                        const error = new Error("aborted");
                        error.name = "AbortError";
                        reject(error);
                    },
                    { once: true },
                );
            });
        },
    });
    await blocking.init();
    const task = await blocking.enqueue({ request: videoRequest(), origin: "test" });
    const deadline = Date.now() + 5000;
    while (!blocking.get(task.id)?.remote && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(blocking.get(task.id)?.remote?.id).toBe("remote-video-1");
    await blocking.shutdown();
    expect(blocking.get(task.id)?.status).toBe("queued");
    expect(blocking.get(task.id)?.phase).toBe("resuming");

    const recovered = new TaskQueue({
        dir,
        runner: async (_request, _inputs, ctx) => {
            expect(ctx.remote?.id).toBe("remote-video-1");
            return { items: [{ url: "https://api.example.test/video.mp4", mimeType: "video/mp4" }], usage: { videoSeconds: 4 } };
        },
    });
    await recovered.init();
    recovered.syncChannels([{ id: "test-channel", name: "Test", baseUrl: "https://api.example.test", apiKey: "secret", apiFormat: "openai", models: [{ name: "test-model", capability: "video" }] }]);
    const finished = await waitForTask(recovered, task.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.result?.items[0].url).toBe("https://api.example.test/video.mp4");
    await recovered.shutdown();
});
