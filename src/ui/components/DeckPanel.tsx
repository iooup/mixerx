import { Pause, Play } from "lucide-react";
import { type DragEvent, useCallback, useState } from "react";
import { t } from "../../app/i18n-core";
import { useGuide } from "../../coach/guide-store";
import { deckActions } from "../../engine/actions";
import { beatPosition, sectionAt, TEMPO_RANGE_PCT } from "../../engine/beat-math";
import { getLibrary } from "../../library/library";
import { libraryStore, useLibrary } from "../../library/library-store";
import type { DeckId, DeckState } from "../../state/session";
import { sessionStore, useSession } from "../../state/session-store";
import { formatTime, useFrameValue } from "../engine-hooks";
import { Waveform } from "./Waveform";

const TRACK_MIME = "text/x-mixerx-track";
const LOOP_LENGTHS = [1, 2, 4, 8, 16, 32];
const JUMPS: { bars: number; label: string }[] = [
  { bars: -4, label: "−4" },
  { bars: -1, label: "−1" },
  { bars: 1, label: "+1" },
  { bars: 4, label: "+4" },
];
/** Keyboard shortcuts per deck (src/ui/keyboard.ts), shown in the corner of each transport button. */
const KEY_HINTS: Record<DeckId, { play: string; cue: string; sync: string }> = {
  A: { play: "Z", cue: "X", sync: "S" },
  B: { play: "M", cue: ",", sync: "K" },
};

function confidenceTone(confidence: number): "ok" | "warn" | "danger" {
  return confidence >= 0.7 ? "ok" : confidence >= 0.4 ? "warn" : "danger";
}

function ConfidenceDot({ confidence, title }: { confidence: number; title: string }) {
  return (
    <span
      className={`dot dot--${confidenceTone(confidence)}`}
      role="img"
      title={title}
      aria-label={title}
      data-testid="confidence"
    />
  );
}

function NudgeButton({ deck, direction }: { deck: DeckId; direction: -1 | 1 }) {
  const release = () => void deckActions.nudge(deck, 0);
  return (
    <button
      type="button"
      className="btn-nudge"
      aria-label={t(direction < 0 ? "deck.nudgeDown" : "deck.nudgeUp", { deck })}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        void deckActions.nudge(deck, direction);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") void deckActions.nudge(deck, direction);
      }}
      onKeyUp={release}
      onBlur={release}
      data-testid={`deck-${deck}-nudge-${direction < 0 ? "down" : "up"}`}
    >
      {direction < 0 ? "−" : "+"}
    </button>
  );
}

function Pads({ id, deck }: { id: DeckId; deck: DeckState }) {
  return (
    <div className="pads" data-testid={`pads-${id}`}>
      <div className="pads__row pads__hotcues" role="group" aria-label={t("deck.hotCues")}>
        {deck.hotCues.map((cue, slot) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: pads are positional slots
            key={slot}
            type="button"
            className={cue === null ? "pad" : "pad pad--set"}
            disabled={!deck.track}
            onClick={(event) =>
              void (event.shiftKey ? deckActions.clearHotCue(id, slot) : deckActions.triggerHotCue(id, slot))
            }
            title={
              cue === null ? t("deck.hotCueSet", { n: slot + 1 }) : t("deck.hotCueJump", { n: slot + 1 })
            }
            data-testid={`hotcue-${id}-${slot + 1}`}
          >
            <span className="pad__n">{slot + 1}</span>
            <span className="pad__time num">{cue === null ? "" : formatTime(cue)}</span>
          </button>
        ))}
      </div>
      <div className="pads__row pads__loops" role="group" aria-label={t("deck.loop")}>
        <span className="pads__label">{t("deck.loop")}</span>
        {LOOP_LENGTHS.map((beats) => (
          <button
            key={beats}
            type="button"
            className="pad pad--small"
            aria-pressed={deck.loop?.beats === beats}
            disabled={!deck.analysis}
            onClick={() => void deckActions.setLoopBeats(id, beats)}
            data-testid={`loop-${id}-${beats}`}
          >
            {beats}
          </button>
        ))}
        <button
          type="button"
          className="pad pad--small"
          disabled={!deck.loop}
          onClick={() => void deckActions.setLoopBeats(id, null)}
          data-testid={`loop-${id}-exit`}
        >
          {t("deck.loopExit")}
        </button>
      </div>
      <div className="pads__row pads__jump" role="group" aria-label={t("deck.jump")}>
        <span className="pads__label">{t("deck.jump")}</span>
        {JUMPS.map((jump) => (
          <button
            key={jump.bars}
            type="button"
            className="pad pad--small"
            disabled={!deck.track}
            onClick={() => void deckActions.jumpBeats(id, jump.bars * 4)}
            aria-label={t("deck.jumpBars", { bars: jump.bars })}
          >
            {jump.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Vertical pitch fader with the nudge buttons under it, beside the waveforms. */
function PitchColumn({ id, deck }: { id: DeckId; deck: DeckState }) {
  const text = `${deck.tempoOffsetPct >= 0 ? "+" : ""}${deck.tempoOffsetPct.toFixed(1)}%`;
  return (
    <div className="pitch" dir="ltr">
      <span className="pitch__label">{t("deck.tempo")}</span>
      <input
        type="range"
        className="pitch__input"
        min={-TEMPO_RANGE_PCT}
        max={TEMPO_RANGE_PCT}
        step={0.1}
        value={deck.tempoOffsetPct}
        disabled={!deck.track}
        aria-label={`${t("deck.tempo")} ${id}`}
        aria-valuetext={text}
        title={t("deck.tempoHint")}
        onChange={(event) => void deckActions.setTempo(id, Number(event.target.value))}
        onDoubleClick={() => void deckActions.setTempo(id, 0)}
        data-testid={`deck-${id}-tempo`}
      />
      <span className="pitch__value num" aria-hidden="true">
        {text}
      </span>
      <span
        className="nudge"
        role="group"
        aria-label={t("deck.nudge", { deck: id })}
        data-guide-target={`nudge-${id}`}
      >
        <NudgeButton deck={id} direction={1} />
        <NudgeButton deck={id} direction={-1} />
      </span>
    </div>
  );
}

export function DeckPanel({ id }: { id: DeckId }) {
  const session = useSession();
  const deck = session.decks[id];
  const library = useLibrary();
  const libraryTrack = deck.track ? library.tracks.find((entry) => entry.id === deck.track?.id) : undefined;
  const { locks } = useGuide();
  const otherOnAir = session.decks[id === "A" ? "B" : "A"].onAir;
  const playLocked = id === "B" && locks.includes("play-B");
  const [dropping, setDropping] = useState(false);
  const className = `panel deck deck--${id.toLowerCase()}${dropping ? " deck--drop" : ""}`;
  const headingId = `deck-${id}-title`;
  const hints = KEY_HINTS[id];

  const live = useFrameValue(
    (frame) => {
      const state = frame?.decks[id];
      if (!state?.trackId) return null;
      const analysis = deck.analysis;
      const section = analysis ? sectionAt(analysis.sections, analysis.grid, state.positionSec) : null;
      return {
        elapsed: formatTime(state.positionSec),
        remaining: formatTime(Math.max(0, state.durationSec - state.positionSec)),
        section: section?.kind ?? null,
        barsToNext: section?.barsToNext ?? null,
        next: section?.next ?? null,
      };
    },
    250,
    (a, b) =>
      a?.elapsed === b?.elapsed &&
      a?.remaining === b?.remaining &&
      a?.section === b?.section &&
      a?.barsToNext === b?.barsToNext &&
      a?.next === b?.next,
  );

  // A scheduled start for this deck shows its count-down on the ENTER button.
  const armed = useFrameValue(
    (frame) => {
      const event = sessionStore.getState().scheduled.find((entry) => entry.targetDeck === id);
      if (!event) return null;
      const analysis = sessionStore.getState().decks[event.referenceDeck].analysis;
      const reference = frame?.decks[event.referenceDeck];
      if (!analysis || !reference) return { beats: null };
      return {
        beats: Math.max(0, Math.ceil(event.atBeatIndex - beatPosition(analysis.grid, reference.positionSec))),
      };
    },
    150,
    (a, b) => a?.beats === b?.beats && (a === null) === (b === null),
  );

  const bpm = deck.analysis ? (deck.analysis.grid.bpm * deck.rate).toFixed(1) : "—";
  const key = deck.analysis?.key.camelot || "—";
  const analysisLabel = libraryTrack
    ? t(`deck.analysis.${libraryTrack.analysisState}`, { stage: libraryTrack.analysisStage ?? "" })
    : "";
  const sectionText = live?.section
    ? live.next && live.barsToNext !== null
      ? t("deck.sectionIn", { section: t(`section.${live.next}`), bars: live.barsToNext })
      : t(`section.${live.section}`)
    : "";
  const other = id === "A" ? "B" : "A";
  const enterLabel = armed
    ? armed.beats === null
      ? t("onair.enterArmed", { deck: id })
      : t("onair.enterIn", { deck: id, n: armed.beats })
    : t("deck.enterHint", { other });

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes(TRACK_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropping(true);
    }
  }, []);

  const onDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDropping(false);
      const trackId = event.dataTransfer.getData(TRACK_MIME);
      if (trackId) {
        await deckActions.load(id, trackId);
        return;
      }
      const files = Array.from(event.dataTransfer.files ?? []);
      if (!files.length) return;
      await getLibrary().addFiles(files, files[0]?.name ?? "Files");
      const first = files[0];
      const match = libraryStore.getState().tracks.find((track) => track.fileName === first?.name);
      if (match) await deckActions.load(id, match.id);
    },
    [id],
  );

  return (
    <section
      className={className}
      aria-labelledby={headingId}
      data-testid={`deck-${id}`}
      data-playing={deck.playing}
      data-on-air={deck.onAir}
      data-loop={deck.loop ? deck.loop.beats : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => void onDrop(event)}
    >
      <header className="deck__head" data-guide-target={`deck-${id}-header`}>
        <span className="deck__letter" aria-hidden="true">
          {id}
        </span>
        <div className="deck__title">
          <strong id={headingId}>{deck.track ? deck.track.title : t(`deck.${id.toLowerCase()}`)}</strong>
          <span className="deck__sub">
            <span className="deck__artist">
              {deck.track ? deck.track.artist || analysisLabel : t("deck.noTrack")}
            </span>
            {deck.track && (
              <b className="deck__section" data-testid={`deck-${id}-section`}>
                {sectionText || analysisLabel}
              </b>
            )}
          </span>
        </div>
        <div className="deck__stats">
          <span>
            <b className="num" data-testid={`deck-${id}-bpm`}>
              {bpm}
              {deck.analysis && (
                <ConfidenceDot
                  confidence={deck.analysis.grid.confidence}
                  title={t("deck.gridConfidence", { pct: Math.round(deck.analysis.grid.confidence * 100) })}
                />
              )}
            </b>
            BPM
          </span>
          <span>
            <b className="num" data-testid={`deck-${id}-key`}>
              {key}
              {deck.analysis && (
                <ConfidenceDot
                  confidence={deck.analysis.key.confidence}
                  title={`${deck.analysis.key.name} · ${Math.round(deck.analysis.key.confidence * 100)} %`}
                />
              )}
            </b>
            KEY
          </span>
          <span className="deck__clock">
            <b className="num deck__time" data-testid={`deck-${id}-time`}>
              {live?.elapsed ?? "--:--"}
            </b>
            <span className="num deck__remaining" title={t("deck.remaining")}>
              {live ? `−${live.remaining}` : ""}
            </span>
          </span>
        </div>
      </header>

      <div className="deck__body">
        <div className="deck__waves">
          <div className="wave">
            {deck.track ? (
              <Waveform
                deck={id}
                mode="overview"
                label={t("deck.seek", { deck: id })}
                onSeek={(sec) => void deckActions.seek(id, sec)}
                onStep={(direction) => void deckActions.stepBars(id, direction)}
              />
            ) : null}
          </div>
          <div className="wave">
            {deck.track ? (
              <Waveform
                deck={id}
                mode="zoom"
                label={t("deck.seek", { deck: id })}
                onSeek={(sec) => void deckActions.seek(id, sec)}
                onStep={(direction) => void deckActions.stepBars(id, direction)}
              />
            ) : (
              <div className="wave__empty">
                <p>{t("deck.dropHint")}</p>
                <span className="muted">{t("deck.openLibrary")}</span>
              </div>
            )}
          </div>
        </div>
        <PitchColumn id={id} deck={deck} />
      </div>

      {session.mode === "perform" && <Pads id={id} deck={deck} />}

      <div className="deck__transport" dir="ltr">
        <button
          type="button"
          onClick={() => void deckActions.cue(id)}
          disabled={!deck.track}
          aria-label={t("deck.cue")}
          aria-keyshortcuts={hints.cue}
          data-testid={`deck-${id}-cue`}
        >
          {t("deck.cue")}
          <kbd className="key-hint">{hints.cue}</kbd>
        </button>
        <button
          type="button"
          className="btn-play"
          onClick={() => void deckActions.togglePlay(id)}
          disabled={!deck.track || playLocked}
          title={playLocked ? t("guide.locked", { n: 5 }) : undefined}
          aria-pressed={deck.playing}
          aria-label={deck.playing ? t("deck.playing") : t("deck.play")}
          aria-keyshortcuts={hints.play}
          data-guide-target={`deck-${id}-play`}
          data-testid={`deck-${id}-play`}
        >
          {deck.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          <span>{deck.playing ? t("deck.playing") : t("deck.play")}</span>
          <kbd className="key-hint">{hints.play}</kbd>
        </button>
        <button
          type="button"
          onClick={() => void deckActions.sync(id)}
          disabled={!deck.analysis}
          aria-label={t("deck.sync")}
          aria-keyshortcuts={hints.sync}
          data-testid={`deck-${id}-sync`}
        >
          {t("deck.sync")}
          <kbd className="key-hint">{hints.sync}</kbd>
        </button>
        {session.mode !== "learn" && (
          <form
            className="deck__enter"
            onSubmit={(event) => {
              event.preventDefault();
              void deckActions.enterOnNextBar(id, { sync: true });
            }}
          >
            <button
              type="submit"
              className={armed ? "tr-enter tr-enter--armed" : "tr-enter"}
              disabled={!deck.track || deck.playing || !otherOnAir}
              title={enterLabel}
              aria-label={enterLabel}
              data-testid={`deck-${id}-enter`}
            >
              {t("deck.enter")}
              {armed && (
                <span className="tr-enter__n num" aria-hidden="true">
                  {armed.beats ?? "•"}
                </span>
              )}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
