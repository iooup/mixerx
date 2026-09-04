import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import { guide } from "../../coach/engine";
import { useGuide } from "../../coach/guide-store";
import { lesson1 } from "../../coach/lessons/lesson1";
import type { GuideTargetId } from "../../coach/types";
import { sessionStore, useSession } from "../../state/session-store";
import { subscribeFrames } from "../engine-hooks";

/** Where each step's card is anchored. Steps whose card carries the control anchor near it. */
/** Twelve dots is enough to read as a burst without becoming fireworks. */
const SPARK_IDS = Array.from({ length: 12 }, (_value, index) => `spark-${index}`);

const ANCHORS: Record<GuideTargetId, string> = {
  library: '[data-guide-target="library"]',
  "deck-A-header": '[data-guide-target="deck-A-header"]',
  calibration: '[data-guide-target="deck-B-header"]',
  "deck-A-play": '[data-guide-target="deck-A-play"]',
  enter: '[data-guide-target="deck-B-play"]',
  "nudge-B": '[data-guide-target="nudge-B"]',
  crossfader: '[data-guide-target="crossfader"]',
  "eq-low-A": '[data-guide-target="eq-low-A"]',
  score: '[data-guide-target="crossfader"]',
};

const CARD_WIDTH = 360;
const GAP = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function placeCard(anchor: Rect, cardHeight: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - 2 * GAP);
  let top = anchor.top + anchor.height + GAP;
  if (top + cardHeight > vh - GAP) top = anchor.top - cardHeight - GAP;
  if (top < GAP)
    top = Math.max(GAP, Math.min(vh - cardHeight - GAP, anchor.top + anchor.height / 2 - cardHeight / 2));
  const left = Math.max(GAP, Math.min(vw - width - GAP, anchor.left + anchor.width / 2 - width / 2));
  return { top, left };
}

export function GuideOverlay() {
  const state = useGuide();
  const session = useSession();
  const step = lesson1.steps[state.stepIndex] ?? null;
  const cardRef = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: GAP, left: GAP });
  const active = session.mode === "learn" && state.status !== "idle" && step !== null;
  const cardOwnsControl = Boolean(step?.cardControls);

  // Measure the anchor every frame (cheap) and re-place the card when it moves.
  useEffect(() => {
    if (!active || !step) return;
    const selector = ANCHORS[step.target];
    return subscribeFrames(() => {
      const element = document.querySelector<HTMLElement>(selector);
      const rect = element ? element.getBoundingClientRect() : null;
      const next = rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
      setAnchor((previous) => (sameRect(previous, next) ? previous : next));
    });
  }, [active, step]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const height = cardRef.current?.offsetHeight ?? 200;
    const next = placeCard(anchor, height);
    setPosition((previous) =>
      Math.round(previous.top) === Math.round(next.top) && Math.round(previous.left) === Math.round(next.left)
        ? previous
        : next,
    );
  }, [anchor]);

  // Exactly one highlighted control: the anchored element, unless the card carries the control.
  useEffect(() => {
    if (!active || !step || cardOwnsControl) return;
    const element = document.querySelector<HTMLElement>(ANCHORS[step.target]);
    element?.setAttribute("data-guide-current", "true");
    return () => element?.removeAttribute("data-guide-current");
  }, [active, step, cardOwnsControl]);

  if (!active || !step) return null;

  const stepNumber = state.stepIndex + 1;
  const scoreParams = state.score
    ? {
        ms: state.score.alignmentMs,
        bars: state.score.blendBars,
        mark: state.score.bassSwapOnBeatOne ? "✓" : "✗",
      }
    : { ms: "—", bars: "—", mark: "—" };
  const endLesson = () => sessionStore.dispatch({ type: "mode/set", mode: "mix" });
  const bReady = Boolean(session.decks.B.analysis && session.decks.A.playing);

  return (
    <>
      <div className="guide-dim" aria-hidden="true" />
      {anchor && !cardOwnsControl && (
        <div
          className="guide-spot"
          aria-hidden="true"
          style={{
            top: anchor.top - 4,
            left: anchor.left - 4,
            width: anchor.width + 8,
            height: anchor.height + 8,
          }}
        />
      )}
      <section
        ref={cardRef}
        className="guide-card"
        role="dialog"
        aria-labelledby="guide-instruction"
        style={{
          top: position.top,
          left: position.left,
          width: Math.min(CARD_WIDTH, window.innerWidth - 2 * GAP),
        }}
        data-testid="guide-card"
        data-step={stepNumber}
        data-status={state.status}
      >
        <header className="guide-card__head">
          <span className="label">
            {t("guide.step", { n: stepNumber, total: state.stepCount })} · {t(lesson1.title)}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("guide.end")}
            onClick={endLesson}
            data-testid="guide-end"
          >
            <X size={14} />
          </button>
        </header>
        <p id="guide-instruction" className="guide-card__instruction" aria-live="polite">
          {t(step.instruction, scoreParams)}
        </p>
        {step.hint && <p className="guide-card__hint muted">{t(step.hint)}</p>}

        {step.id === "check" && (
          <p className="guide-card__progress num" data-testid="guide-progress">
            {t("guide.alignedBeats", { n: Number(state.progress.alignedBeats ?? 0), total: 8 })}
          </p>
        )}
        {step.id === "blend" && (
          <p className="guide-card__progress num" data-testid="guide-progress">
            {t("guide.barsInZone", { n: Number(state.progress.barsInZone ?? 0), total: 4 })}
          </p>
        )}

        {step.cardControls === "calibration" && (
          <div className="guide-card__controls" data-testid="guide-calibration">
            <button
              type="button"
              aria-pressed={Boolean(state.calibration?.looping)}
              onClick={() => void guide.toggleCalibrationLoop()}
              disabled={!session.decks.B.analysis}
              data-testid="guide-loop"
            >
              {t("guide.calibration.loop")}
            </button>
            <span className="guide-card__row">
              <button
                type="button"
                onClick={() => void guide.adjustCalibration({ beats: -1 })}
                data-testid="guide-beat-minus"
              >
                {t("guide.calibration.beatMinus")}
              </button>
              <button
                type="button"
                onClick={() => void guide.adjustCalibration({ beats: 1 })}
                data-testid="guide-beat-plus"
              >
                {t("guide.calibration.beatPlus")}
              </button>
              <button
                type="button"
                onClick={() => void guide.adjustCalibration({ ms: -10 })}
                data-testid="guide-ms-minus"
              >
                {t("guide.calibration.msMinus")}
              </button>
              <button
                type="button"
                onClick={() => void guide.adjustCalibration({ ms: 10 })}
                data-testid="guide-ms-plus"
              >
                {t("guide.calibration.msPlus")}
              </button>
            </span>
            <span className="muted num">
              {t("guide.calibration.state", {
                beat: (state.calibration?.downbeatOffset ?? 0) + 1,
                ms: state.calibration?.gridOffsetMs ?? 0,
              })}
            </span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void guide.confirmCalibration()}
              disabled={!session.decks.B.analysis}
              data-guide-current="true"
              data-testid="guide-confirm"
            >
              {t("guide.calibration.confirm")}
            </button>
          </div>
        )}

        {step.cardControls === "enter" && (
          <div className="guide-card__controls">
            <button
              type="button"
              className="btn-primary btn-enter"
              onClick={() => void guide.enterB()}
              disabled={!bReady || session.scheduled.length > 0}
              data-guide-current="true"
              data-testid="guide-enter"
            >
              {t("guide.enter")}
            </button>
            {session.scheduled.length > 0 && <span className="muted">{t("guide.enterArmed")}</span>}
          </div>
        )}

        {step.demo && state.status === "running" && (
          <div className="guide-card__controls">
            <button type="button" onClick={() => guide.showMe()} data-testid="guide-show-me">
              {t("guide.showMe")}
            </button>
          </div>
        )}
        {state.status === "demo" && <p className="muted">{t("guide.demoRunning")}</p>}
        {state.status === "demo-done" && (
          <div className="guide-card__controls">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void guide.yourTurn()}
              data-testid="guide-your-turn"
            >
              {t("guide.yourTurn")}
            </button>
          </div>
        )}

        {step.cardControls === "score" && (
          <div className="guide-card__controls" data-testid="guide-score">
            {/* A quiet celebration: the crowd's own sparks, in CSS, gone in under two seconds.
                Reduced motion gets the card without the motion. */}
            <span className="guide-sparks" aria-hidden="true" data-testid="guide-sparks">
              {SPARK_IDS.map((id) => (
                <i key={id} className="guide-sparks__dot" />
              ))}
            </span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void guide.replay()}
              data-guide-current="true"
              data-testid="guide-replay"
            >
              {t("guide.replay")}
            </button>
            <button type="button" disabled title={t("guide.lesson2Hint")}>
              {t("guide.lesson2")}
            </button>
            <button type="button" onClick={endLesson}>
              {t("guide.backToMix")}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
