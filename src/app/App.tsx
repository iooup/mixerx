import { lazy, Suspense } from "react";
import { useRoute } from "./router";
import { ConsolePage } from "./routes/ConsolePage";

// The Stage (WebGPU renderer, Director, crowd) is its own chunk: the console never pays for it.
const StagePage = lazy(() => import("./routes/StagePage").then((module) => ({ default: module.StagePage })));

export function App() {
  const route = useRoute();
  return route === "stage" ? (
    <Suspense fallback={<main className="stage stage--connect" data-testid="stage-loading" />}>
      <StagePage />
    </Suspense>
  ) : (
    <ConsolePage />
  );
}
