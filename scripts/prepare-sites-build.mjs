#!/usr/bin/env node
/**
 * Assemble the Sites deployment layout:
 *   dist/client/index.html  (Vite output, already carries the CSP meta tag)
 *   dist/server/index.js    (worker with the production CSP header inlined)
 *   dist/.openai/hosting.json
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_CSP_PLACEHOLDER, landingHeaders } from "../mixerx/security.mjs";
import { CSP_PLACEHOLDER, PRODUCTION_CSP_HEADER } from "./csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error(`Missing Sites build input: ${file}`);
}

const workerSource = readFileSync(worker, "utf8");
if (!workerSource.includes(CSP_PLACEHOLDER) || !workerSource.includes(LANDING_CSP_PLACEHOLDER)) {
  throw new Error("worker/index.js must contain both CSP placeholders");
}

if (process.argv.includes("--include-introduction")) {
  const introduction = path.join(root, "mixerx", "dist");
  if (!existsSync(path.join(introduction, "index.html"))) {
    throw new Error("Build the introduction page before including it in the Sites package");
  }
  cpSync(introduction, path.join(dist, "client", "mixerx"), { recursive: true });
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
writeFileSync(
  path.join(dist, "server", "index.js"),
  workerSource
    .replaceAll(CSP_PLACEHOLDER, PRODUCTION_CSP_HEADER)
    .replaceAll(LANDING_CSP_PLACEHOLDER, landingHeaders(PRODUCTION_CSP_HEADER)["Content-Security-Policy"]),
);
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

console.log("Prepared Sites build: dist/server/index.js and dist/.openai/hosting.json");
