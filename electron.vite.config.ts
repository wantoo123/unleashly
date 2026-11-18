import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

import { parseChangelog } from "./src/renderer/src/lib/release";

const projectRoot = process.cwd();
const rendererRoot = resolve(projectRoot, "src/renderer");
const version = readFileSync(resolve(projectRoot, "VERSION"), "utf8").trim() || "dev";
const changelog = readFileSync(resolve(projectRoot, "CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// Development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(rendererRoot, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                "@shared": resolve(projectRoot, "src/shared"),
            },
        },
        build: {
            outDir: resolve(projectRoot, "out/main"),
            rollupOptions: {
                input: resolve(projectRoot, "src/main/index.ts"),
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                "@shared": resolve(projectRoot, "src/shared"),
            },
        },
        build: {
            outDir: resolve(projectRoot, "out/preload"),
            rollupOptions: {
                input: resolve(projectRoot, "src/preload/index.ts"),
            },
        },
    },
    renderer: {
        root: rendererRoot,
        plugins: [react(), localPluginsManifest()],
        resolve: {
            alias: {
                "@": resolve(rendererRoot, "src"),
                "@shared": resolve(projectRoot, "src/shared"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(version),
            __APP_RELEASES__: JSON.stringify(parseChangelog(changelog)),
        },
        build: {
            outDir: resolve(projectRoot, "out/renderer"),
            rollupOptions: {
                input: resolve(rendererRoot, "index.html"),
            },
        },
    },
});
