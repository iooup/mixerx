/**
 * The set as a constellation: one star per track played, in the key's own colour, sized by its
 * energy, joined by faint lines in the order they went on air. The track playing now pulses with
 * the beat. It comes up in breaks, outros and idle — the moments when the audience has room to
 * look — and can be pinned on or off from the Director panel.
 */
import { type Ref, useImperativeHandle, useMemo, useRef } from "react";
import type { Intent } from "../director";
import type { NightEntry } from "../protocol";
import { placeStars, type Star, skyVisible } from "./night-math";

export interface NightSkyHandle {
  update(intent: Intent, dt: number, mode: "auto" | "always" | "off"): void;
}

interface NightSkyProps {
  night: readonly NightEntry[];
  ref?: Ref<NightSkyHandle>;
}

const VIEW_W = 1600;
const VIEW_H = 900;

const point = (star: Star) => `${(star.x * VIEW_W).toFixed(1)},${(star.y * VIEW_H).toFixed(1)}`;

export function NightSky({ night, ref }: NightSkyProps) {
  const rootRef = useRef<SVGSVGElement>(null);
  const currentRef = useRef<SVGCircleElement>(null);
  const shownRef = useRef(0);
  const stars = useMemo(() => placeStars(night), [night]);
  const path = useMemo(() => (stars.length < 2 ? "" : `M${stars.map(point).join("L")}`), [stars]);
  const current = stars.at(-1) ?? null;

  useImperativeHandle(ref, () => ({
    update(intent, dt, mode) {
      const root = rootRef.current;
      if (!root) return;
      const wanted = !intent.blackout && stars.length > 0 && skyVisible(mode, intent.section, intent.idle);
      // Two seconds in, one second out: the sky arrives quietly and leaves before the drop.
      shownRef.current += (Number(wanted) - shownRef.current) * (1 - Math.exp(-dt / (wanted ? 0.9 : 0.4)));
      const shown = shownRef.current;
      root.style.setProperty("--sky", shown.toFixed(3));
      root.setAttribute("data-visible", shown > 0.02 ? "true" : "false");
      if (shown <= 0.02 || !currentRef.current) return;
      // The record on air breathes with the beat; reduced motion leaves it steady.
      const pulse = intent.reducedMotion ? 1 : 1 + 0.55 * (1 - intent.beat.phase) ** 2;
      currentRef.current.setAttribute("r", ((current?.r ?? 0.01) * VIEW_H * pulse).toFixed(2));
    },
  }));

  return (
    <svg
      ref={rootRef}
      className="night-sky"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMin slice"
      aria-hidden="true"
      data-testid="night-sky"
      data-visible="false"
      data-count={stars.length}
    >
      <path className="night-sky__path" d={path} />
      {stars.map((star) => (
        <circle
          key={star.id}
          className="night-sky__star"
          cx={(star.x * VIEW_W).toFixed(1)}
          cy={(star.y * VIEW_H).toFixed(1)}
          r={(star.r * VIEW_H).toFixed(2)}
          style={star.hue === null ? undefined : { fill: `hsl(${star.hue.toFixed(0)} 75% 74%)` }}
        />
      ))}
      {current && (
        <circle
          ref={currentRef}
          className="night-sky__star night-sky__star--now"
          cx={(current.x * VIEW_W).toFixed(1)}
          cy={(current.y * VIEW_H).toFixed(1)}
          r={(current.r * VIEW_H).toFixed(2)}
          style={current.hue === null ? undefined : { fill: `hsl(${current.hue.toFixed(0)} 85% 82%)` }}
        />
      )}
    </svg>
  );
}
