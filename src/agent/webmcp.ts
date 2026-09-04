/**
 * WebMCP adapter: registers the registry's tools for the current context (mode × autonomy) with
 * one AbortController controlling each registration context.
 *
 * Every tool the mode allows is registered at every autonomy level, including the `act` tools.
 * Autonomy is enforced when the call runs, not by hiding the tool: below Co-DJ the registry
 * answers `proposed` and the person confirms on the card. Registration cannot carry that policy,
 * because a declarative form — the only way to ask for a press without an imperative tool — is
 * not supported outside Chromium.
 */
import type { Autonomy, SessionMode } from "../state/session";
import { sessionStore } from "../state/session-store";
import { detectModelContext, type ModelContextDetection } from "./detect";
import type { ToolRegistry } from "./registry";
import type { ToolDefinition, ToolResult } from "./types";

interface RegisterOptions {
  signal: AbortSignal;
}

export class WebMcpAdapter {
  private controller: AbortController | null = null;
  private context: { mode: SessionMode; autonomy: Autonomy } | null = null;
  private unsubscribe: (() => void) | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  readonly detection: ModelContextDetection;

  constructor(
    private readonly registry: ToolRegistry,
    detection: ModelContextDetection = detectModelContext(),
  ) {
    this.detection = detection;
  }

  start(): void {
    this.stop();
    this.unsubscribe = sessionStore.subscribe(() => this.scheduleSync());
    this.scheduleSync();
  }

  /**
   * A single session action can dispatch several store updates, so registration is debounced to
   * the settled context; re-registering mid-change would abort a controller Chromium is still
   * reading and leave the reported tool count wrong.
   */
  private scheduleSync(delayMs = 30): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, delayMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.context = null;
  }

  /** Re-registers the tool subset when the context changes; reports the truth to the strip. */
  sync(): void {
    const { mode, autonomy, agent } = sessionStore.getState();
    if (!this.detection.available || !this.detection.context) {
      if (agent.webmcp !== "unavailable")
        sessionStore.dispatch({ type: "agent/webmcp", status: "unavailable", toolCount: 0 });
      return;
    }
    if (this.context && this.context.mode === mode && this.context.autonomy === autonomy) return;
    this.context = { mode, autonomy };
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const tools = this.registry.forContext(mode, autonomy);
    let count = 0;
    for (const tool of tools) {
      try {
        const registration = this.detection.context.registerTool(this.toModelContextTool(tool), {
          signal: controller.signal,
        } satisfies RegisterOptions);
        if (registration && typeof (registration as Promise<unknown>).catch === "function") {
          (registration as Promise<unknown>).catch((error: unknown) => {
            console.warn(`[webmcp] registration rejected for ${tool.name}`, error);
            if (/duplicate/i.test(String(error)) && this.retries < 3) {
              this.retries += 1;
              this.context = null;
              this.scheduleSync(150);
            }
          });
        }
        count += 1;
      } catch (error) {
        console.warn(`[webmcp] registerTool failed for ${tool.name}`, error);
      }
    }
    if (count === tools.length) this.retries = 0;
    sessionStore.dispatch({
      type: "agent/webmcp",
      status: count > 0 ? "registered" : "available",
      toolCount: count,
    });
  }

  private toModelContextTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: async (input: unknown, options?: { signal?: AbortSignal }) => {
        const ctx = options?.signal
          ? { caller: "webmcp" as const, signal: options.signal }
          : { caller: "webmcp" as const };
        const result: ToolResult = await this.registry.invoke(tool.name, input ?? {}, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result) }], ...result };
      },
    };
  }
}
