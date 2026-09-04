/**
 * Optional natural-language explanation of a proposal through Chrome's on-device Prompt API
 *. Never required and never on the critical path: absent → the button is hidden.
 */
import type { Proposal } from "../state/session";

interface LanguageModelSession {
  prompt(text: string): Promise<string>;
  destroy?(): void;
}

interface LanguageModelLike {
  availability(): Promise<string>;
  create(options?: Record<string, unknown>): Promise<LanguageModelSession>;
}

function languageModel(): LanguageModelLike | null {
  const candidate = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  if (!candidate || typeof candidate !== "object") return null;
  const like = candidate as Partial<LanguageModelLike>;
  return typeof like.availability === "function" && typeof like.create === "function"
    ? (like as LanguageModelLike)
    : null;
}

export async function explainAvailable(): Promise<boolean> {
  const model = languageModel();
  if (!model) return false;
  try {
    const availability = await model.availability();
    return availability !== "unavailable";
  } catch {
    return false;
  }
}

export async function explainProposal(proposal: Proposal): Promise<string> {
  const model = languageModel();
  if (!model) throw new Error("Prompt API not available");
  const session = await model.create();
  try {
    const facts = [`Proposal: ${proposal.title}`, ...proposal.reasons.map((reason) => `- ${reason}`)].join(
      "\n",
    );
    return await session.prompt(
      `You are an AI DJ agent. In English, explain in at most two sentences why this proposal makes sense for the DJ. Use only these facts and do not invent numbers:\n${facts}`,
    );
  } finally {
    session.destroy?.();
  }
}
