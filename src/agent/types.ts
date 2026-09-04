/** Agent-layer contracts. */
import type { Autonomy, Proposal, SessionMode } from "../state/session";

export type ToolAccess = "read" | "prepare" | "act";
export type ToolCaller = "webmcp" | "local" | "harness";
export type ToolContext = SessionMode | "copilot-only";

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: (string | number)[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}

export interface ToolResult<T = unknown> {
  status: "ok" | "proposed" | "accepted" | "error";
  data?: T;
  proposalId?: string;
  liveOutputChanged: boolean;
  confirmationRequired?: boolean;
  error?: string;
}

export interface ToolCallContext {
  caller: ToolCaller;
  signal?: AbortSignal;
  /** Set when a user confirmed a proposal that carried this call. */
  confirmedBy?: "user";
}

/** Thrown by handlers: the message is guidance for the agent, not a dead end. */
export class ToolError extends Error {
  readonly guidance: string;
  constructor(guidance: string) {
    super(guidance);
    this.name = "ToolError";
    this.guidance = guidance;
  }
}

export interface UndoHandle {
  label: string;
  run(): Promise<void>;
}

export interface ToolOutcome<O> {
  data: O;
  /** Present when the tool changed state that can be restored. */
  undo?: UndoHandle;
  liveOutputChanged?: boolean;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string; // verb-based, kebab-case
  title: string;
  description: string;
  inputSchema: JsonSchema;
  access: ToolAccess;
  annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean };
  contexts: ToolContext[];
  handler(input: I, ctx: ToolCallContext): Promise<ToolOutcome<O>>;
  /** Preconditions checked before the policy decision; throw a ToolError with guidance. */
  precheck?(input: I): void;
  /** How the tool call reads as a proposal card when policy defers it to the user. */
  describe?(input: I): { kind: Proposal["kind"]; title: string; reasons: string[] };
}

export interface ActivityEntry {
  id: string;
  at: number;
  tool: string;
  caller: ToolCaller;
  args: string; // short summary, never paths
  status: ToolResult["status"];
  durationMs: number;
  confirmedBy?: "user";
  undoLabel?: string;
  undone?: boolean;
  error?: string;
}

export const AUTONOMY_ORDER: Record<Autonomy, number> = { observe: 0, prepare: 1, copilot: 2 };

/** Which access levels may run without asking at each autonomy level. */
export function permitted(access: ToolAccess, autonomy: Autonomy): boolean {
  if (access === "read") return true;
  if (access === "prepare") return AUTONOMY_ORDER[autonomy] >= AUTONOMY_ORDER.prepare;
  return autonomy === "copilot";
}
