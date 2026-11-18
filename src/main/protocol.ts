import { net, protocol } from "electron";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { log } from "./services/logger";

const SCHEME = "app";
const HOST = "unleashly";

const CSP = [
    "default-src 'self'",
    // blob: is required by the runtime plugin loader; unsafe-eval is required by user-authored
    // model invocation scripts. Both should be replaced by a sandboxed worker in a later phase.
    "script-src 'self' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: blob: data:",
    "frame-src 'self' https: http: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
};

let rendererRoot = "";

export function registerAppScheme() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
                stream: true,
            },
        },
    ]);
}

async function serveFile(filePath: string) {
    const response = await net.fetch(pathToFileURL(filePath).toString());
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", CSP);
    const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()];
    if (contentType) headers.set("content-type", contentType);
    return new Response(response.body, { status: response.status, headers });
}

export function registerAppProtocol(root: string) {
    rendererRoot = resolve(root);
    protocol.handle(SCHEME, async (request) => {
        try {
            const url = new URL(request.url);
            if (url.host !== HOST) return new Response("Not found", { status: 404 });

            let pathname = decodeURIComponent(url.pathname);
            if (!pathname || pathname === "/") pathname = "/index.html";
            const filePath = resolve(rendererRoot, `.${pathname}`);
            if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
                return new Response("Forbidden", { status: 403 });
            }

            const response = await serveFile(filePath);
            if (response.ok || extname(pathname)) return response;

            // SPA fallback for extensionless routes.
            return await serveFile(resolve(rendererRoot, "index.html"));
        } catch (error) {
            log.warn("Failed to serve app:// request", { url: request.url, error });
            return new Response("Not found", { status: 404 });
        }
    });
}
