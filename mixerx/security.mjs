import { PRODUCTION_CSP_META, SECURITY_HEADERS } from "../scripts/csp.mjs";

// Only the introduction page may load the owner's opt-in YouTube demo.
// The Console and Stage retain scripts/csp.mjs without this exception.
export const DEMO_FRAME_POLICY = "frame-src https://www.youtube-nocookie.com";
export const LANDING_CSP_META = `${PRODUCTION_CSP_META}; ${DEMO_FRAME_POLICY}`;
export const LANDING_CSP_PLACEHOLDER = "__MIXERX_LANDING_CSP__";

export function landingHeaders(policy = PRODUCTION_CSP_META) {
  return {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": `${policy}; ${DEMO_FRAME_POLICY}`,
    // The third-party player cannot join the instrument's isolated browsing context.
    "Cross-Origin-Embedder-Policy": "unsafe-none",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function isLandingDocument(url) {
  const path = url.split("?")[0];
  return path === "/mixerx/" || path === "/mixerx/index.html";
}
