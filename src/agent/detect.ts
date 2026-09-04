/**
 * WebMCP feature detection: prefer document.modelContext, then check navigator.modelContext.
 * The adapter registers tools only when a compatible registerTool method is available.
 */

export interface ModelContextLike {
  registerTool: (tool: unknown, options?: unknown) => Promise<unknown> | unknown;
}

export interface ModelContextDetection {
  available: boolean;
  surface: "document" | "navigator" | null;
  context: ModelContextLike | null;
}

function readSurface(holder: unknown): ModelContextLike | null {
  if (!holder || typeof holder !== "object") return null;
  const candidate = (holder as { modelContext?: unknown }).modelContext;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof (candidate as ModelContextLike).registerTool === "function"
    ? (candidate as ModelContextLike)
    : null;
}

export function detectModelContext(
  scope: { document?: unknown; navigator?: unknown } = globalThis as {
    document?: unknown;
    navigator?: unknown;
  },
): ModelContextDetection {
  const fromDocument = readSurface(scope.document);
  if (fromDocument) return { available: true, surface: "document", context: fromDocument };
  const fromNavigator = readSurface(scope.navigator);
  if (fromNavigator) return { available: true, surface: "navigator", context: fromNavigator };
  return { available: false, surface: null, context: null };
}
