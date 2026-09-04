import { useEffect, useRef, useState } from "react";
import { ALL_TOOLS, registry } from "../../agent";
import { t } from "../../app/i18n-core";
import { AUTONOMY_LEVELS, sessionStore, useSession } from "../../state/session-store";

const SAMPLE_INPUTS: Record<string, string> = {
  "get-session": "{}",
  "search-library": '{ "query": "", "limit": 5 }',
  "get-track": '{ "trackId": "" }',
  "propose-transition": "{}",
  "plan-set": '{ "trackIds": [], "target": "peak" }',
  "propose-scene": "{}",
  "load-deck": '{ "deck": "B", "trackId": "" }',
  "set-queue": '{ "trackIds": [] }',
  "preview-cue": '{ "trackId": "" }',
  "arm-transition": "{}",
  "enter-deck": '{ "deck": "B" }',
  "apply-scene": '{ "sceneId": "drop-burst" }',
};

export function DevHarness({ open, onClose }: { open: boolean; onClose(): void }) {
  const { autonomy, mode, agent } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const [tool, setTool] = useState("get-session");
  const [input, setInput] = useState(SAMPLE_INPUTS["get-session"] ?? "{}");
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const registered = new Set(registry.forContext(mode, autonomy).map((entry) => entry.name));

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      const parsed = input.trim() ? JSON.parse(input) : {};
      const outcome = await registry.invoke(tool, parsed, { caller: "harness" });
      setResult(JSON.stringify(outcome, null, 2));
    } catch (error) {
      setResult(
        JSON.stringify(
          { status: "error", error: error instanceof Error ? error.message : String(error) },
          null,
          2,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="harness"
      onClose={onClose}
      onCancel={onClose}
      dir="ltr"
      data-testid="harness"
    >
      <form method="dialog" className="harness__form" onSubmit={(event) => event.preventDefault()}>
        <header className="harness__head">
          <h2 className="harness__title">{t("harness.title")}</h2>
          <span className="muted">
            {mode} · {autonomy} · WebMCP {agent.webmcp} ({agent.toolCount})
          </span>
        </header>
        <div className="harness__row">
          <label>
            <span className="label">{t("rail.autonomy")}</span>
            <select
              value={autonomy}
              onChange={(event) =>
                sessionStore.dispatch({
                  type: "autonomy/set",
                  autonomy: event.target.value as typeof autonomy,
                })
              }
              data-testid="harness-autonomy"
            >
              {AUTONOMY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">{t("harness.tool")}</span>
            <select
              value={tool}
              onChange={(event) => {
                setTool(event.target.value);
                setInput(SAMPLE_INPUTS[event.target.value] ?? "{}");
              }}
              data-testid="harness-tool"
            >
              {ALL_TOOLS.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name} · {entry.access}
                  {registered.has(entry.name) ? " · registered" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="harness__input">
          <span className="label">{t("harness.input")}</span>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={4}
            spellCheck={false}
            data-testid="harness-input"
          />
        </label>
        <div className="harness__actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void run()}
            data-testid="harness-run"
          >
            {t("harness.run")}
          </button>
          <button type="button" onClick={onClose}>
            {t("audio.close")}
          </button>
        </div>
        <pre className="harness__result" data-testid="harness-result">
          {result}
        </pre>
        <ul className="harness__tools">
          {ALL_TOOLS.map((entry) => (
            <li key={entry.name}>
              <b>{entry.name}</b> · {entry.access} · {entry.contexts.join("/")} · {entry.description}
            </li>
          ))}
        </ul>
      </form>
    </dialog>
  );
}
