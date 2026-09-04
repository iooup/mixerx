/**
 * The now-playing lower third: what a club screen shows when a record drops in — title, artist, a
 * key chip in the track's own colour, the tempo, and the cover if the file carries one. It slides
 * in over 0.6 s, holds for six seconds and leaves. No glow, no flashing, no countdown: it is type
 * on a dark card, in IBM Plex Sans. Driven per frame from the render loop, never through React
 * state.
 */
import { type Ref, useImperativeHandle, useRef } from "react";
import type { Intent } from "../director";
import { camelotHue } from "../palette";
import type { NowPlaying } from "../protocol";
import { initialLowerThird, type LowerThirdState, stepLowerThird } from "./lower-third-math";

export interface LowerThirdHandle {
  /** Advances the card. Returns how much of it is on screen (0 … 1). */
  update(intent: Intent, dt: number, now: NowPlaying | null, enabled: boolean): number;
}

interface LowerThirdProps {
  ref?: Ref<LowerThirdHandle>;
}

/** A new track (or a new deck) slides the card in again. */
const keyOf = (now: NowPlaying | null): string => (now ? `${now.deck}|${now.title}|${now.artist}` : "");
/** Anything that changes what the card says — the analysis lands after the load. */
const contentOf = (now: NowPlaying | null): string =>
  now ? `${keyOf(now)}|${now.camelot}|${now.keyName}|${now.bpm}|${now.artwork ? "art" : ""}` : "";

export function LowerThird({ ref }: LowerThirdProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const artistRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const bpmRef = useRef<HTMLSpanElement>(null);
  const artRef = useRef<HTMLImageElement>(null);
  const stateRef = useRef<LowerThirdState>(initialLowerThird());
  const lastKeyRef = useRef("");
  const lastContentRef = useRef("");

  useImperativeHandle(ref, () => ({
    update(intent, dt, now, enabled) {
      const root = rootRef.current;
      if (!root) return 0;
      const key = keyOf(now);
      const content = contentOf(now);
      const trigger = key !== "" && key !== lastKeyRef.current;
      if (trigger) lastKeyRef.current = key;
      if (content !== "" && content !== lastContentRef.current) {
        lastContentRef.current = content;
        root.setAttribute("data-deck", now?.deck ?? "A");
        const title = titleRef.current;
        const artist = artistRef.current;
        const chip = chipRef.current;
        const bpm = bpmRef.current;
        const art = artRef.current;
        if (title) title.textContent = now?.title ?? "";
        if (artist) artist.textContent = now?.artist ?? "";
        if (chip) {
          chip.textContent = now?.camelot ? `${now.camelot} · ${now.keyName}` : "";
          chip.hidden = !now?.camelot;
          const hue = camelotHue(now?.camelot);
          chip.style.setProperty("--chip-hue", hue === null ? "210" : hue.toFixed(0));
        }
        if (bpm) bpm.textContent = now?.bpm ? `${now.bpm.toFixed(1)} BPM` : "";
        if (art) {
          if (now?.artwork) {
            art.src = now.artwork;
            art.hidden = false;
          } else {
            art.removeAttribute("src");
            art.hidden = true;
          }
        }
      }
      if (key === "") lastKeyRef.current = "";
      const next = stepLowerThird(stateRef.current, dt, trigger, enabled && !intent.blackout && key !== "");
      stateRef.current = next;
      root.style.setProperty("--lt", next.progress.toFixed(3));
      root.setAttribute("data-visible", next.progress > 0.02 ? "true" : "false");
      return next.progress;
    },
  }));

  return (
    <div
      ref={rootRef}
      className="lower-third"
      data-testid="lower-third"
      data-visible="false"
      aria-hidden="true"
    >
      <img ref={artRef} className="lower-third__art" alt="" hidden width={96} height={96} />
      <div className="lower-third__text">
        <span ref={titleRef} className="lower-third__title" dir="auto" data-testid="lower-third-title" />
        <span ref={artistRef} className="lower-third__artist" dir="auto" />
      </div>
      <div className="lower-third__meta">
        <span ref={chipRef} className="lower-third__chip" hidden />
        <span ref={bpmRef} className="lower-third__bpm num" />
      </div>
    </div>
  );
}
