#!/usr/bin/env node
/**
 * Build gate: the production output must carry the strict policy and reference nothing external.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_CSP_META, LANDING_CSP_PLACEHOLDER, landingHeaders } from "../mixerx/security.mjs";
import { CSP_PLACEHOLDER, PRODUCTION_CSP_HEADER, PRODUCTION_CSP_META } from "./csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "dist", "client", "index.html");
const workerPath = path.join(root, "dist", "server", "index.js");

const decodeEntities = (value) =>
  value
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const failures = [];
const indexHtml = readFileSync(indexPath, "utf8");
const metaMatch = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i);
if (!metaMatch) failures.push("dist/client/index.html is missing the production CSP meta tag");
else if (decodeEntities(metaMatch[1]) !== PRODUCTION_CSP_META) {
  failures.push(`dist/client/index.html carries an unexpected policy: ${decodeEntities(metaMatch[1])}`);
}
const externalReference = /\b(?:src|href)=["'](?:https?:)?\/\//i;
if (externalReference.test(indexHtml)) failures.push("dist/client/index.html references an external URL");

const workerSource = readFileSync(workerPath, "utf8");
if (workerSource.includes(CSP_PLACEHOLDER))
  failures.push("dist/server/index.js still contains the CSP placeholder");
if (!workerSource.includes(PRODUCTION_CSP_HEADER))
  failures.push("dist/server/index.js does not serve the production CSP header");
if (workerSource.includes(LANDING_CSP_PLACEHOLDER))
  failures.push("dist/server/index.js still contains the introduction CSP placeholder");
if (!workerSource.includes(landingHeaders(PRODUCTION_CSP_HEADER)["Content-Security-Policy"]))
  failures.push("dist/server/index.js does not serve the introduction CSP header");

const introductionPath = path.join(root, "dist", "client", "mixerx", "index.html");
if (existsSync(introductionPath)) {
  const html = readFileSync(introductionPath, "utf8");
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i);
  if (!meta || decodeEntities(meta[1]) !== LANDING_CSP_META)
    failures.push("The packaged introduction page is missing its isolated production CSP");
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("PASS production CSP meta tag, worker header, and no external references");
