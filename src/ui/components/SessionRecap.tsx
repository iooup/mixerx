/**
 * End of set. One screen: what was played and when, the shape the night took, how many
 * transitions, and the badges earned in LEARN. Exported as a PNG or as JSON by the DJ's own hand —
 * both are drawn and saved here, in this tab. Nothing is uploaded, because there is nowhere to
 * upload it to.
 */
import { Download, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import "../console-strings";
import { type ArcSample, nightArc } from "../../state/night-arc";
import { readJson, safeStorage } from "../../state/store";
import type { NightEntry } from "../../visuals/protocol";
import {
  BADGES_KEY,
  type BadgeState,
  buildRecap,
  emptyBadges,
  type Recap,
  recapJson,
} from "../recap/recap-model";

interface RecapProps {
  open: boolean;
  onClose(): void;
}

const clock = (at: number): string => {
  const date = new Date(at);
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
};

/** The night's arc as a small sparkline, reused by the PNG export. */
function paintArc(
  context: CanvasRenderingContext2D,
  samples: readonly ArcSample[],
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  context.fillStyle = "#181b21";
  context.fillRect(x, y, width, height);
  if (!samples.length) return;
  // The recap shows the set it actually was, edge to edge, not an hour with a set in one corner.
  const step = width / samples.length;
  context.fillStyle = "#5beb8a";
  for (const [index, sample] of samples.entries()) {
    const bar = Math.max(1, sample.energy * height);
    context.globalAlpha = sample.trackId ? 0.9 : 0.3;
    context.fillRect(x + index * step, y + height - bar, Math.max(1, step), bar);
  }
  context.globalAlpha = 1;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function SessionRecap({ open, onClose }: RecapProps) {
  const [night, setNight] = useState<NightEntry[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const badges: BadgeState = readJson<BadgeState>(safeStorage(), BADGES_KEY) ?? emptyBadges();

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    void import("../../visuals/console-bridge").then((bridge) => {
      setNight(bridge.getStageBridge().nightEntries());
    });
    const timer = setTimeout(() => closeRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const recap: Recap = useMemo(
    () => buildRecap(night, nightArc.samples, badges),
    // The arc is a live ring; it is read once when the overlay opens, which is what a recap is.
    [night, badges],
  );

  if (!open) return null;

  const close = () => {
    onClose();
    returnFocusRef.current?.focus?.();
  };

  const exportPng = () => {
    const width = 1200;
    const rows = Math.min(recap.tracks.length, 18);
    const height = 260 + rows * 30;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#0b0c0e";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#edeff3";
    context.font = "600 30px 'IBM Plex Sans', sans-serif";
    context.fillText(t("recap.title"), 48, 62);
    context.fillStyle = "#a7aebb";
    context.font = "16px 'IBM Plex Sans', sans-serif";
    context.fillText(
      `${clock(recap.from)} – ${clock(recap.to)} · ${Math.round(recap.minutes)} min · ${recap.tracks.length} · ${recap.transitions}`,
      48,
      92,
    );
    paintArc(context, nightArc.samples, 48, 118, width - 96, 80);
    context.font = "15px 'IBM Plex Sans', sans-serif";
    recap.tracks.slice(0, rows).forEach((track, index) => {
      const y = 240 + index * 30;
      context.fillStyle = "#7d8590";
      context.fillText(clock(track.startedAt), 48, y);
      context.fillStyle = "#edeff3";
      context.fillText(track.title, 130, y);
      context.fillStyle = "#a7aebb";
      context.fillText(
        `${track.camelot} · ${track.bpm ? track.bpm.toFixed(1) : "—"} · ${track.energy}/10`,
        width - 260,
        y,
      );
    });
    canvas.toBlob((blob) => {
      if (blob) saveBlob(blob, `mixerx-set-${new Date(recap.from).toISOString().slice(0, 10)}.png`);
    }, "image/png");
  };

  const exportJson = () =>
    saveBlob(
      new Blob([recapJson(recap)], { type: "application/json" }),
      `mixerx-set-${new Date(recap.from).toISOString().slice(0, 10)}.json`,
    );

  return (
    <div className="recap-layer">
      <button
        type="button"
        className="recap-backdrop"
        aria-label={t("keys.close")}
        onClick={close}
        data-testid="recap-backdrop"
      />
      <div
        ref={dialogRef}
        className="recap"
        role="dialog"
        aria-modal="true"
        aria-label={t("recap.title")}
        data-testid="recap"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <header className="recap__head">
          <h2 className="recap__title-text">{t("recap.title")}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label={t("keys.close")}
            onClick={close}
            data-testid="recap-close"
          >
            <X size={16} />
          </button>
        </header>
        <dl className="recap__stats" data-testid="recap-stats">
          <div>
            <dt>{t("recap.tracks")}</dt>
            <dd className="num">{recap.tracks.length}</dd>
          </div>
          <div>
            <dt>{t("recap.minutes")}</dt>
            <dd className="num">{Math.round(recap.minutes)}</dd>
          </div>
          <div>
            <dt>{t("recap.transitions")}</dt>
            <dd className="num">{recap.transitions}</dd>
          </div>
          <div>
            <dt>{t("recap.energy")}</dt>
            <dd className="num">{Math.round(recap.meanEnergy * 10)}/10</dd>
          </div>
          {recap.badges.bestAlignmentMs !== null && (
            <div>
              <dt>{t("recap.best")}</dt>
              <dd className="num">{Math.round(recap.badges.bestAlignmentMs)} ms</dd>
            </div>
          )}
          {recap.badges.streak > 0 && (
            <div>
              <dt>{t("recap.streak")}</dt>
              <dd className="num">{recap.badges.streak}</dd>
            </div>
          )}
        </dl>
        <RecapArc />
        {recap.badges.earned.length > 0 && (
          <ul className="recap__badges" data-testid="recap-badges">
            {recap.badges.earned.map((badge) => (
              <li key={badge} className="recap__badge">
                {t(`badge.${badge}`)}
              </li>
            ))}
          </ul>
        )}
        {recap.tracks.length === 0 ? (
          <p className="recap__empty" data-testid="recap-empty">
            {t("recap.empty")}
          </p>
        ) : (
          <ol className="recap__list" data-testid="recap-list">
            {recap.tracks.map((track) => (
              <li key={`${track.id}-${track.startedAt}`} className="recap__row">
                <span className="num recap__time">{clock(track.startedAt)}</span>
                <span className="recap__title" dir="auto">
                  {track.title}
                </span>
                <span className="recap__artist" dir="auto">
                  {track.artist}
                </span>
                <span className="num recap__meta">
                  {track.camelot || "—"} · {track.bpm ? track.bpm.toFixed(1) : "—"} · {track.energy}/10
                </span>
              </li>
            ))}
          </ol>
        )}
        <footer className="recap__foot">
          <button type="button" onClick={exportPng} data-testid="recap-png">
            <Download size={14} /> {t("recap.png")}
          </button>
          <button type="button" onClick={exportJson} data-testid="recap-json">
            <Download size={14} /> {t("recap.json")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The same arc the strip shows, drawn once when the recap opens. */
function RecapArc() {
  const label = t("arc.label", { count: nightArc.length });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    paintArc(context, nightArc.samples, 0, 0, canvas.width, canvas.height);
  }, []);
  return <canvas ref={canvasRef} className="recap__arc" role="img" aria-label={label} />;
}
