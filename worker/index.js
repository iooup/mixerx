/**
 * Sites worker. Serves the static client and adds the security headers.
 * CSP placeholders are replaced by scripts/prepare-sites-build.mjs using
 * scripts/csp.mjs and the introduction page's isolated media policy.
 */
export const CONTENT_SECURITY_POLICY = "__MIXERX_PRODUCTION_CSP__";
export const LANDING_CONTENT_SECURITY_POLICY = "__MIXERX_LANDING_CSP__";

export const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self), tools=(self)",
});

export function withSecurityHeaders(response, landingDocument = false) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set(
    "Content-Security-Policy",
    landingDocument ? LANDING_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY,
  );
  if (landingDocument) {
    headers.set("Cross-Origin-Embedder-Policy", "unsafe-none");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const readRequest = ["GET", "HEAD"].includes(request.method);
    if (url.pathname === "/mixerx" && readRequest) {
      url.pathname = "/mixerx/";
      return withSecurityHeaders(Response.redirect(url, 308));
    }
    if (readRequest && ["/mixerx/", "/mixerx/index.html"].includes(url.pathname)) {
      url.pathname = "/mixerx/index.html";
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(url, request)), true);
    }

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !readRequest || url.pathname.startsWith("/mixerx/")) {
      return withSecurityHeaders(response);
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(indexUrl, request)));
  },
};
