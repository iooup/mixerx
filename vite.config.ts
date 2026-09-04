import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { isLandingDocument, landingHeaders } from "./mixerx/security.mjs";
import {
  DEV_CSP_HEADER,
  PRODUCTION_CSP_HEADER,
  PRODUCTION_CSP_META,
  SECURITY_HEADERS,
} from "./scripts/csp.mjs";

/** Injects the production Content-Security-Policy as a meta tag (build only). */
function cspMeta(): Plugin {
  return {
    name: "mixerx:csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: PRODUCTION_CSP_META },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    cspMeta(),
    {
      name: "mixerx:landing-demo-dev",
      configureServer(server) {
        // Serve only the landing document with its opt-in embed policy. All instrument
        // requests keep the original CSP and cross-origin isolation headers below.
        server.middlewares.use(async (req, res, next) => {
          if (!isLandingDocument(req.url ?? "") || (req.method !== "GET" && req.method !== "HEAD")) {
            next();
            return;
          }
          try {
            const source = await readFile(resolve(server.config.root, "mixerx/index.html"), "utf8");
            const html = await server.transformIndexHtml(req.url ?? "/mixerx/", source);
            for (const [name, value] of Object.entries(landingHeaders(DEV_CSP_HEADER)))
              res.setHeader(name, value);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(req.method === "HEAD" ? undefined : html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist/client",
    target: "es2023",
    sourcemap: false,
  },
  server: {
    host: "0.0.0.0",
    port: 4187,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    headers: { ...SECURITY_HEADERS, "Content-Security-Policy": DEV_CSP_HEADER },
  },
  preview: {
    port: 4188,
    headers: { ...SECURITY_HEADERS, "Content-Security-Policy": PRODUCTION_CSP_HEADER },
  },
});
