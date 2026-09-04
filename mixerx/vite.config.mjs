import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { DEV_CSP_HEADER, PRODUCTION_CSP_HEADER } from "../scripts/csp.mjs";
import { LANDING_CSP_META, landingHeaders } from "./security.mjs";

// Separate output: this page never changes the Console's route or its entry budget.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [
    {
      name: "mixerx-page:csp",
      transformIndexHtml: {
        order: "post",
        handler: () => [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: LANDING_CSP_META },
            injectTo: "head-prepend",
          },
        ],
      },
    },
  ],
  server: { headers: landingHeaders(DEV_CSP_HEADER) },
  preview: { headers: landingHeaders(PRODUCTION_CSP_HEADER) },
  // Every capture stays a file: the tests check them, and inlined data URIs would bloat the HTML.
  build: { outDir: "dist", target: "es2023", assetsInlineLimit: 0 },
});
