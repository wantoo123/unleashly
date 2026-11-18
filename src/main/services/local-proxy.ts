import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { log } from "./logger";

const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

let proxyServer: Server | null = null;
let proxyUrl = "";

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function readTarget(rawUrl: string, token: string) {
    const prefix = `/${token}/`;
    if (!rawUrl.startsWith(prefix)) return "";
    let target = rawUrl.slice(prefix.length);
    // Some clients collapse the "//" in the embedded target URL; restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    try {
        const url = new URL(target);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
        return "";
    }
}

function requestHeaders(req: IncomingMessage) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream: Response) {
    const headers: Record<string, string> = { ...CORS_HEADERS };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function redactUrl(value: string) {
    try {
        const url = new URL(value);
        for (const key of ["key", "api_key", "apikey", "token", "access_token"]) {
            if (url.searchParams.has(key)) url.searchParams.set(key, "***");
        }
        return url.toString();
    } catch {
        return value;
    }
}

async function forward(req: IncomingMessage, res: ServerResponse, target: string) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const upstream = await fetch(target, {
        method: req.method,
        headers: requestHeaders(req),
        body: body as unknown as BodyInit | undefined,
        redirect: "follow",
        signal: controller.signal,
    });
    res.writeHead(upstream.status, responseHeaders(upstream));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on("error", (error) => log.warn("Proxy stream failed", error));
    stream.pipe(res);
    return upstream.status;
}

export function getProxyUrl() {
    return proxyUrl;
}

export async function startLocalProxy(): Promise<string> {
    if (proxyServer) return proxyUrl;
    const token = randomBytes(16).toString("hex");
    const server = createServer((req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        const target = readTarget(req.url || "/", token);
        if (!target) {
            sendJson(res, 403, { error: "Proxy target is missing or invalid" });
            return;
        }
        const startedAt = Date.now();
        forward(req, res, target)
            .then((status) => log.info(`proxy ${req.method} ${redactUrl(target)} -> ${status} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`))
            .catch((error) => {
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                log.warn("Proxy request failed", { target: redactUrl(target), error });
                sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
            });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    if (!port) {
        server.close();
        throw new Error("Failed to start local proxy");
    }
    proxyServer = server;
    proxyUrl = `http://127.0.0.1:${port}/${token}`;
    log.info(`Local proxy listening on ${proxyUrl}`);
    return proxyUrl;
}

export function stopLocalProxy() {
    if (!proxyServer) return;
    proxyServer.close();
    proxyServer = null;
    proxyUrl = "";
}
