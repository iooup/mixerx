import { LocalCopilot } from "./copilot";
import { ToolRegistry } from "./registry";
import { registerAllTools } from "./tools";
import { WebMcpAdapter } from "./webmcp";

export const registry = new ToolRegistry();
registerAllTools(registry);
export const copilot = new LocalCopilot(registry);
export const webmcp = new WebMcpAdapter(registry);

let started = false;

/** Starts the adapters once (called by the console page). */
export function startAgentLayer(): void {
  if (started) return;
  started = true;
  webmcp.start();
  copilot.start();
  if (import.meta.env.DEV) {
    (globalThis as { mixerx?: unknown }).mixerx = {
      list: () =>
        registry.list().map((tool) => ({ name: tool.name, access: tool.access, contexts: tool.contexts })),
      invoke: (name: string, input: unknown) => registry.invoke(name, input ?? {}, { caller: "harness" }),
      accept: (id: string) => registry.accept(id),
    };
  }
}

export function stopAgentLayer(): void {
  if (!started) return;
  started = false;
  webmcp.stop();
  copilot.stop();
}

export { ALL_TOOLS } from "./tools";
export type { ToolDefinition, ToolResult } from "./types";
