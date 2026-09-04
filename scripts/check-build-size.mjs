#!/usr/bin/env node
/**
 * Build gate: bundle budgets. Fonts are bundled locally, so the complete-output budget
 * is generous while JavaScript stays tight.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDirectory = path.join(root, "dist", "client");

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

const formatBytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const indexHtml = await readFile(path.join(clientDirectory, "index.html"), "utf8");
const entryMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!entryMatch) throw new Error("Could not find the Vite entry script in dist/client/index.html");

const entryPath = path.join(clientDirectory, entryMatch[1].replace(/^\//, ""));
const files = await collectFiles(clientDirectory);
const scripts = files.filter((file) => file.endsWith(".js"));
const scriptBuffers = await Promise.all(scripts.map((file) => readFile(file)));
const entryBuffer = await readFile(entryPath);
const totalClientBytes = (await Promise.all(files.map((file) => stat(file)))).reduce(
  (total, file) => total + file.size,
  0,
);
const totalScriptGzipBytes = scriptBuffers.reduce((total, buffer) => total + gzipSync(buffer).byteLength, 0);
// The four requested cinematic scenes bundle six local images. Keep the original application
// budget and a separate bounded artwork allowance, so image work cannot hide a code regression.
const cinematicFiles = files.filter((file) =>
  /\/(phoenix-sky|phoenix|spectral-garden|spectral-gate|astral-lotus|crystal-voyage)-[^/]+\.webp$/.test(file),
);
const cinematicBytes = (await Promise.all(cinematicFiles.map((file) => stat(file)))).reduce(
  (total, file) => total + file.size,
  0,
);

const budgets = [
  { label: "entry JavaScript (gzip)", actual: gzipSync(entryBuffer).byteLength, limit: 120 * 1024 },
  { label: "all JavaScript (gzip)", actual: totalScriptGzipBytes, limit: 220 * 1024 },
  {
    label: "client excluding cinematic artwork",
    actual: totalClientBytes - cinematicBytes,
    limit: 3 * 1024 * 1024,
  },
  { label: "cinematic artwork", actual: cinematicBytes, limit: 2 * 1024 * 1024 },
  { label: "complete client output", actual: totalClientBytes, limit: 5 * 1024 * 1024 },
];

let failed = false;
for (const budget of budgets) {
  const ok = budget.actual <= budget.limit;
  failed ||= !ok;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${budget.label}: ${formatBytes(budget.actual)} / ${formatBytes(budget.limit)}`,
  );
}
if (failed) process.exitCode = 1;
