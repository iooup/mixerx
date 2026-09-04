import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../app/i18n-core";
import { uiStore } from "../../state/ui-store";
import { withViewTransition } from "../view-transition";

/** Corner preview of the audience output (fallback when Document Picture-in-Picture is missing). */
export function StagePreview() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void import("../../visuals/console-bridge").then((bridge) => {
      setUrl(bridge.stageUrl(bridge.getStageBridge().sessionId, "preview"));
    });
  }, []);
  return (
    <aside className="stage-preview" aria-label={t("stage.preview.title")} data-testid="stage-preview">
      <div className="stage-preview__head">
        <span className="label">{t("stage.preview.title")}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("stage.preview.close")}
          onClick={() => withViewTransition(() => uiStore.dispatch({ type: "ui/stagePreview", open: false }))}
        >
          <X size={14} />
        </button>
      </div>
      {url && <iframe src={url} title={t("stage.preview.title")} />}
    </aside>
  );
}
