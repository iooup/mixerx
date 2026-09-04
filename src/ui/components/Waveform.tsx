import { useCallback, useEffect, useRef } from "react";
import type { WaveformSummary } from "../../analysis/waveform";
import { getEngine } from "../../engine";
import { beatPosition, secAtBeat } from "../../engine/beat-math";
import { getLibrary } from "../../library/library";
import type { DeckId, DeckState, Section } from "../../state/session";
import { useSession } from "../../state/session-store";
import { useEngineFrame } from "../engine-hooks";

const SECTION_COLOURS: Record<Section["kind"], string> = {
  intro: "#4b5563",
  build: "#b98a2f",
  drop: "#c2410c",
  break: "#1d4ed8",
  body: "#374151",
  outro: "#4b5563",
};

interface WaveformProps {
  deck: DeckId;
  mode: "overview" | "zoom";
  label: string;
  zoomSeconds?: number;
  onSeek?: (sec: number) => void;
  /** Keyboard stepping (ArrowLeft/ArrowRight): −1 / +1 bar. */
  onStep?: (direction: -1 | 1) => void;
}

interface DrawContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  colour: string;
}

function deckColour(deck: DeckId): string {
  return deck === "A" ? "#ffa03c" : "#3fd5ff";
}

function lighten(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)} ${mix(g)} ${mix(b)})`;
}

/** Draws 3-band columns from `bins` (peak, low, mid, high per bin) between bin indices. */
function drawColumns(
  { ctx, width, height, colour }: DrawContext,
  bins: Uint8Array,
  firstBin: number,
  binsPerPixel: number,
  x0: number,
  x1: number,
): void {
  const mid = height / 2;
  const total = bins.length / 4;
  const lowColour = colour;
  const midColour = lighten(colour, 0.45);
  const highColour = "rgba(255, 255, 255, 0.85)";
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
    const start = Math.floor(firstBin + (x - x0) * binsPerPixel);
    const end = Math.max(start + 1, Math.floor(firstBin + (x + 1 - x0) * binsPerPixel));
    if (end <= 0 || start >= total) continue;
    let peak = 0;
    let low = 0;
    let midBand = 0;
    let high = 0;
    let count = 0;
    for (let bin = Math.max(0, start); bin < Math.min(total, end); bin += 1) {
      peak = Math.max(peak, bins[bin * 4] ?? 0);
      low += bins[bin * 4 + 1] ?? 0;
      midBand += bins[bin * 4 + 2] ?? 0;
      high += bins[bin * 4 + 3] ?? 0;
      count += 1;
    }
    if (!count) continue;
    const scale = (peak / 255) * mid * 0.96;
    const lowHeight = scale * (low / count / 255);
    const midHeight = scale * (midBand / count / 255);
    const highHeight = scale * (high / count / 255);
    ctx.fillStyle = lowColour;
    ctx.fillRect(x, mid - lowHeight, 1, lowHeight * 2);
    ctx.fillStyle = midColour;
    ctx.fillRect(x, mid - midHeight, 1, midHeight * 2);
    ctx.fillStyle = highColour;
    ctx.fillRect(x, mid - highHeight, 1, highHeight * 2);
  }
}

function drawSections(draw: DrawContext, deckState: DeckState, secondsToX: (sec: number) => number): void {
  const analysis = deckState.analysis;
  if (!analysis) return;
  const { ctx, height } = draw;
  const grid = analysis.grid;
  for (const section of analysis.sections) {
    const startSec = secAtBeat(grid, grid.downbeatOffset + section.startBar * 4);
    const endSec = secAtBeat(grid, grid.downbeatOffset + section.endBar * 4);
    const x0 = secondsToX(startSec);
    const x1 = secondsToX(endSec);
    ctx.fillStyle = SECTION_COLOURS[section.kind];
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), Math.max(2, height * 0.05));
    ctx.globalAlpha = 1;
  }
}

function drawBeatGrid(
  draw: DrawContext,
  deckState: DeckState,
  windowStart: number,
  windowEnd: number,
  secondsToX: (sec: number) => number,
): void {
  const analysis = deckState.analysis;
  if (!analysis) return;
  const { ctx, height } = draw;
  const grid = analysis.grid;
  const firstBeat = Math.floor(beatPosition(grid, windowStart));
  const lastBeat = Math.ceil(beatPosition(grid, windowEnd));
  if (lastBeat - firstBeat > 400) return;
  for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
    const sec = secAtBeat(grid, beat);
    const x = Math.round(secondsToX(sec)) + 0.5;
    const barBeat = (((beat - grid.downbeatOffset) % 4) + 4) % 4;
    const phraseStart = barBeat === 0 && ((((beat - grid.downbeatOffset) / 4) % 8) + 8) % 8 === 0;
    ctx.strokeStyle = phraseStart
      ? "rgba(255,255,255,0.7)"
      : barBeat === 0
        ? "rgba(255,255,255,0.4)"
        : "rgba(255,255,255,0.14)";
    ctx.lineWidth = phraseStart ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, barBeat === 0 ? 0 : height * 0.3);
    ctx.lineTo(x, barBeat === 0 ? height : height * 0.7);
    ctx.stroke();
  }
}

function drawMarker(draw: DrawContext, x: number, colour: string, width = 2): void {
  const { ctx, height } = draw;
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x) - width / 2, 0, width, height);
}

export function Waveform({ deck, mode, label, zoomSeconds = 12, onSeek, onStep }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const staticKey = useRef("");
  const deckState = useSession().decks[deck];
  const stateRef = useRef(deckState);
  stateRef.current = deckState;
  const waveformRef = useRef<WaveformSummary | null>(null);

  useEffect(() => {
    const library = getLibrary();
    const id = deckState.track?.id ?? null;
    waveformRef.current = id ? (deckState.analysis?.waveform ?? library.getWaveform(id)) : null;
    staticKey.current = "";
    return library.onWaveform((trackId, waveform) => {
      if (trackId === stateRef.current.track?.id) {
        waveformRef.current = waveform;
        staticKey.current = "";
      }
    });
  }, [deckState.track?.id, deckState.analysis]);

  useEngineFrame((frame) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (!cssWidth || !cssHeight) return;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      staticKey.current = "";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const state = stateRef.current;
    const waveform = waveformRef.current;
    const deckFrame = frame?.decks[deck];
    const duration = deckFrame?.durationSec || state.track?.durationSec || 0;
    const position = deckFrame?.positionSec ?? 0;
    const draw: DrawContext = { ctx, width: cssWidth, height: cssHeight, colour: deckColour(deck) };
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (!state.track || !waveform || duration <= 0) return;
    const sampleRate = ((waveform.bins.length / 4) * waveform.hop) / duration;

    if (mode === "overview") {
      const key = `${state.track.id}:${cssWidth}:${cssHeight}:${state.analysis ? 1 : 0}:${waveform.bins.length}`;
      if (staticKey.current !== key || !staticRef.current) {
        const layer = staticRef.current ?? document.createElement("canvas");
        layer.width = canvas.width;
        layer.height = canvas.height;
        const layerCtx = layer.getContext("2d");
        if (layerCtx) {
          layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          layerCtx.clearRect(0, 0, cssWidth, cssHeight);
          const layerDraw: DrawContext = { ...draw, ctx: layerCtx };
          const overviewBins = waveform.overview.length >= 8 ? waveform.overview : waveform.bins;
          const totalBins = overviewBins.length / 4;
          drawColumns(layerDraw, overviewBins, 0, totalBins / cssWidth, 0, cssWidth);
          drawSections(layerDraw, state, (sec) => (sec / duration) * cssWidth);
        }
        staticRef.current = layer;
        staticKey.current = key;
      }
      ctx.drawImage(staticRef.current, 0, 0, cssWidth, cssHeight);
      drawMarker(draw, (state.cueSec / duration) * cssWidth, "rgba(255,255,255,0.55)", 1);
      if (state.loop) {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        const x0 = (state.loop.startSec / duration) * cssWidth;
        const x1 = (state.loop.endSec / duration) * cssWidth;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
      }
      drawMarker(draw, (position / duration) * cssWidth, "#ffffff", 2);
      return;
    }

    const windowStart = position - zoomSeconds / 2;
    const windowEnd = position + zoomSeconds / 2;
    const pixelsPerSecond = cssWidth / zoomSeconds;
    const secondsToX = (sec: number) => (sec - windowStart) * pixelsPerSecond;
    const binsPerSecond = sampleRate / waveform.hop;
    const firstBin = windowStart * binsPerSecond;
    drawColumns(draw, waveform.bins, firstBin, binsPerSecond / pixelsPerSecond, 0, cssWidth);
    drawBeatGrid(draw, state, windowStart, windowEnd, secondsToX);
    drawSections(draw, state, secondsToX);
    if (state.loop) {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      const x0 = secondsToX(state.loop.startSec);
      const x1 = secondsToX(state.loop.endSec);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
    }
    drawMarker(draw, secondsToX(state.cueSec), "rgba(255,255,255,0.55)", 1);
    drawMarker(draw, cssWidth / 2, "#ffffff", 2);
  });

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onSeek) return;
      const canvas = canvasRef.current;
      const state = stateRef.current;
      if (!canvas || !state.track) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const duration = state.track.durationSec;
      if (mode === "overview") {
        onSeek(Math.max(0, Math.min(duration, (x / rect.width) * duration)));
        return;
      }
      const position = getLibraryPosition(deck);
      const offset = ((x - rect.width / 2) / rect.width) * zoomSeconds;
      onSeek(Math.max(0, Math.min(duration, position + offset)));
    },
    [deck, mode, onSeek, zoomSeconds],
  );

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!onStep) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        onStep(event.key === "ArrowLeft" ? -1 : 1);
      }
    },
    [onStep],
  );

  return (
    <button
      type="button"
      className={mode === "overview" ? "wave-btn wave-btn--overview" : "wave-btn wave-btn--zoom"}
      aria-label={label}
      onClick={handleClick}
      onKeyDown={handleKey}
      data-testid={`wave-${mode}-${deck}`}
    >
      <canvas ref={canvasRef} className="wave-canvas" />
    </button>
  );
}

function getLibraryPosition(deck: DeckId): number {
  return getEngine()?.frame().decks[deck].positionSec ?? 0;
}
