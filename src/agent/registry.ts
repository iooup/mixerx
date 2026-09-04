/**
 * Tool registry and policy. Every tool is defined once; adapters
 * (WebMCP, local agent, harness) call `invoke`. Below the permitted autonomy level a call
 * does not fail: it becomes a Proposal the user can accept, and the log records `confirmedBy`.
 */
import type { Autonomy, Proposal, SessionMode } from "../state/session";
import { sessionStore } from "../state/session-store";
import { logActivity } from "./activity-store";
import { validate } from "./schema";
import {
  permitted,
  type ToolCallContext,
  type ToolCaller,
  type ToolDefinition,
  ToolError,
  type ToolResult,
} from "./types";

const KEEP_CLOSED_PROPOSALS = 8;

function summariseArgs(input: unknown): string {
  try {
    const text = JSON.stringify(input ?? {});
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return "{…}";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly pending = new Map<string, { tool: string; input: unknown; caller: ToolCaller }>();
  private proposalCounter = 0;

  register<I, O>(tool: ToolDefinition<I, O>): void {
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Tools registered for a context: LEARN → read subset, MIX/PERFORM → read + prepare, Co-DJ adds act. */
  forContext(mode: SessionMode, autonomy: Autonomy): ToolDefinition[] {
    return this.list().filter((tool) => {
      if (tool.contexts.includes(mode)) return true;
      return tool.contexts.includes("copilot-only") && autonomy === "copilot" && mode !== "learn";
    });
  }

  async invoke(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const args = summariseArgs(input);
    const started = performance.now();
    if (!tool) {
      return {
        status: "error",
        error: `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}.`,
        liveOutputChanged: false,
      };
    }
    const errors = validate(tool.inputSchema, input ?? {});
    if (errors.length) {
      const error = `Invalid input for ${name}: ${errors.join("; ")}.`;
      logActivity({ tool: name, caller: ctx.caller, args, status: "error", durationMs: 0, error });
      return { status: "error", error, liveOutputChanged: false };
    }
    if (tool.precheck) {
      try {
        tool.precheck(input);
      } catch (error) {
        const message =
          error instanceof ToolError
            ? error.guidance
            : error instanceof Error
              ? error.message
              : String(error);
        logActivity({ tool: name, caller: ctx.caller, args, status: "error", durationMs: 0, error: message });
        return { status: "error", error: message, liveOutputChanged: false };
      }
    }
    const autonomy = sessionStore.getState().autonomy;
    if (!ctx.confirmedBy && !permitted(tool.access, autonomy)) {
      const proposal = this.propose(tool, input, ctx.caller);
      logActivity({
        tool: name,
        caller: ctx.caller,
        args,
        status: "proposed",
        durationMs: Math.round(performance.now() - started),
      });
      return {
        status: "proposed",
        proposalId: proposal.id,
        liveOutputChanged: false,
        confirmationRequired: true,
      };
    }
    try {
      const outcome = await tool.handler(input, ctx);
      const entry = {
        tool: name,
        caller: ctx.caller,
        args,
        status: "ok" as const,
        durationMs: Math.round(performance.now() - started),
      };
      logActivity(ctx.confirmedBy ? { ...entry, confirmedBy: ctx.confirmedBy } : entry, outcome.undo);
      return {
        status: "ok",
        data: outcome.data,
        liveOutputChanged: outcome.liveOutputChanged ?? tool.access === "act",
      };
    } catch (error) {
      const message =
        error instanceof ToolError ? error.guidance : error instanceof Error ? error.message : String(error);
      logActivity({
        tool: name,
        caller: ctx.caller,
        args,
        status: "error",
        durationMs: Math.round(performance.now() - started),
        error: message,
      });
      return { status: "error", error: message, liveOutputChanged: false };
    }
  }

  propose(tool: ToolDefinition, input: unknown, caller: ToolCaller): Proposal {
    this.proposalCounter += 1;
    const described = tool.describe?.(input) ?? { kind: "load" as const, title: tool.title, reasons: [] };
    const proposal: Proposal = {
      id: `p-${Date.now().toString(36)}-${this.proposalCounter}`,
      createdAt: Date.now(),
      source: caller === "webmcp" ? "webmcp" : "local",
      kind: described.kind,
      title: described.title,
      reasons: described.reasons,
      payload: { tool: tool.name, input },
      status: "open",
    };
    this.pending.set(proposal.id, { tool: tool.name, input, caller });
    sessionStore.dispatch({ type: "proposal/add", proposal });
    sessionStore.dispatch({ type: "proposal/prune", keep: KEEP_CLOSED_PROPOSALS });
    return proposal;
  }

  /** User confirmation: runs the deferred call and marks the proposal accepted on success. */
  async accept(id: string): Promise<ToolResult> {
    const pending = this.pending.get(id);
    if (!pending) {
      return { status: "error", error: `Proposal ${id} is not open.`, liveOutputChanged: false };
    }
    const result = await this.invoke(pending.tool, pending.input, {
      caller: pending.caller,
      confirmedBy: "user",
    });
    if (result.status === "ok") {
      this.pending.delete(id);
      sessionStore.dispatch({ type: "proposal/status", id, status: "accepted" });
    }
    return result;
  }

  dismiss(id: string): void {
    this.pending.delete(id);
    sessionStore.dispatch({ type: "proposal/status", id, status: "dismissed" });
  }

  expire(id: string): void {
    this.pending.delete(id);
    sessionStore.dispatch({ type: "proposal/status", id, status: "expired" });
  }

  pendingCall(id: string): { tool: string; input: unknown } | null {
    const pending = this.pending.get(id);
    return pending ? { tool: pending.tool, input: pending.input } : null;
  }
}
