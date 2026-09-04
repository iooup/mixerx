/**
 * Single source of truth for the security policy.
 *
 * - The production Content-Security-Policy is injected as a <meta> tag at build time
 *   (vite.config.ts) and served as a header by the Sites worker (worker/index.js, where
 *   the placeholder below is replaced by scripts/prepare-sites-build.mjs).
 * - The development server relaxes only script-src/style-src so Vite's HMR client and
 *   injected styles work; connect-src stays 'self' so the offline probe is meaningful in dev.
 */

const directives = [
  "default-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "img-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/** Policy for the <meta http-equiv> tag (frame-ancestors is ignored in meta). */
export const PRODUCTION_CSP_META = directives.join("; ");

/** Policy for the HTTP header. */
export const PRODUCTION_CSP_HEADER = `${PRODUCTION_CSP_META}; frame-ancestors 'none'`;

/** Development header: identical network policy, relaxed inline script/style for Vite. */
export const DEV_CSP_HEADER = PRODUCTION_CSP_HEADER.replace(
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
).replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");

/** Headers shared by the dev server and the Sites worker. */
export const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self), tools=(self)",
});

/** Literal replaced inside worker/index.js when the Sites build is prepared. */
export const CSP_PLACEHOLDER = "__MIXERX_PRODUCTION_CSP__";
