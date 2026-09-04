import { describe, expect, it } from "vitest";
import { LANDING_CSP_PLACEHOLDER, landingHeaders } from "../../mixerx/security.mjs";
import {
  CSP_PLACEHOLDER,
  DEV_CSP_HEADER,
  PRODUCTION_CSP_HEADER,
  PRODUCTION_CSP_META,
  SECURITY_HEADERS,
} from "../../scripts/csp.mjs";
import worker, {
  CONTENT_SECURITY_POLICY,
  LANDING_CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS as WORKER_HEADERS,
  withSecurityHeaders,
} from "../../worker/index.js";

describe("security policy", () => {
  it("never allows network egress beyond the page origin", () => {
    for (const policy of [PRODUCTION_CSP_META, PRODUCTION_CSP_HEADER, DEV_CSP_HEADER]) {
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).not.toMatch(/https?:/);
      expect(policy).not.toContain("*");
    }
  });

  it("relaxes only inline script and style for the development server", () => {
    const strict = PRODUCTION_CSP_HEADER.split("; ").sort();
    const dev = DEV_CSP_HEADER.split("; ").sort();
    const differences = dev.filter((directive) => !strict.includes(directive));
    expect(differences).toEqual([
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
    ]);
    expect(PRODUCTION_CSP_META).not.toContain("frame-ancestors");
    expect(PRODUCTION_CSP_HEADER).toContain("frame-ancestors 'none'");
  });

  it("keeps the worker headers identical to the shared definition and inlines the policy at build time", () => {
    expect({ ...WORKER_HEADERS }).toEqual({ ...SECURITY_HEADERS });
    expect(CONTENT_SECURITY_POLICY).toBe(CSP_PLACEHOLDER);
    expect(LANDING_CONTENT_SECURITY_POLICY).toBe(LANDING_CSP_PLACEHOLDER);
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(SECURITY_HEADERS["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });

  it("adds every header to a response and falls back to index.html for unknown HTML routes", async () => {
    const decorated = withSecurityHeaders(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(decorated.headers.get(name)).toBe(value);
    expect(decorated.headers.get("Content-Security-Policy")).toBe(CSP_PLACEHOLDER);
    expect(decorated.headers.get("content-type")).toBe("text/plain");

    const requests: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          requests.push(new URL(request.url).pathname);
          return new URL(request.url).pathname === "/index.html"
            ? new Response("<html></html>", { status: 200 })
            : new Response("missing", { status: 404 });
        },
      },
    };
    const response = await worker.fetch(
      new Request("https://app.local/stage", { headers: { accept: "text/html" } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(requests).toEqual(["/stage", "/index.html"]);
    const asset = await worker.fetch(
      new Request("https://app.local/missing.js", { headers: { accept: "*/*" } }),
      env,
    );
    expect(asset.status).toBe(404);
  });

  it.each(["/mixerx/", "/mixerx/index.html"])(
    "serves the introduction at %s with only its document-specific media policy",
    async (route) => {
      const requests: string[] = [];
      const env = {
        ASSETS: {
          fetch: async (request: Request) => {
            requests.push(request.url);
            return new Response("introduction", { headers: { "content-type": "text/html" } });
          },
        },
      };
      const response = await worker.fetch(new Request(`https://app.local${route}?demo=1`), env);
      expect(requests).toEqual(["https://app.local/mixerx/index.html?demo=1"]);
      expect(await response.text()).toBe("introduction");
      const expected = landingHeaders(PRODUCTION_CSP_HEADER);
      for (const [name, value] of Object.entries(expected)) {
        expect(response.headers.get(name)).toBe(
          name === "Content-Security-Policy" ? LANDING_CSP_PLACEHOLDER : value,
        );
      }
    },
  );

  it("redirects the introduction's bare route without losing query parameters", async () => {
    const env = {
      ASSETS: {
        fetch: async () => {
          throw new Error("Unexpected asset request");
        },
      },
    };
    const response = await worker.fetch(new Request("https://app.local/mixerx?demo=1"), env);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://app.local/mixerx/?demo=1");
  });

  it("preserves HEAD and does not fall back when the introduction is absent", async () => {
    const requests: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          return new Response(null, { status: 404 });
        },
      },
    };
    const response = await worker.fetch(
      new Request("https://app.local/mixerx/", { method: "HEAD", headers: { accept: "text/html" } }),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(requests).toEqual(["HEAD /mixerx/index.html"]);
  });

  it.each(["/mixerx/assets/missing.js", "/mixerx/missing"])(
    "does not fall back to the app or relax security for %s",
    async (route) => {
      const requests: string[] = [];
      const env = {
        ASSETS: {
          fetch: async (request: Request) => {
            requests.push(new URL(request.url).pathname);
            return new Response("missing", { status: 404 });
          },
        },
      };
      const response = await worker.fetch(
        new Request(`https://app.local${route}`, { headers: { accept: "text/html" } }),
        env,
      );
      expect(response.status).toBe(404);
      expect(requests).toEqual([route]);
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
      expect(response.headers.get("Content-Security-Policy")).toBe(CSP_PLACEHOLDER);
    },
  );

  it("keeps successful instrument responses isolated and never rewrites POST requests", async () => {
    const requests: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          return new Response("asset", { status: request.method === "POST" ? 405 : 200 });
        },
      },
    };
    for (const route of ["/", "/stage", "/mixerx/assets/main.js"]) {
      const response = await worker.fetch(new Request(`https://app.local${route}`), env);
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
      expect(response.headers.get("Content-Security-Policy")).toBe(CSP_PLACEHOLDER);
    }
    const response = await worker.fetch(
      new Request("https://app.local/mixerx/", { method: "POST", headers: { accept: "text/html" } }),
      env,
    );
    expect(response.status).toBe(405);
    expect(requests).toEqual(["GET /", "GET /stage", "GET /mixerx/assets/main.js", "POST /mixerx/"]);
    expect(response.headers.get("Content-Security-Policy")).toBe(CSP_PLACEHOLDER);
  });
});
