/**
 * The energy arc of the night: a thin band under the ON-AIR strip showing the last hour — the
 * energy the audience heard, coloured by section, with a tick where each record started and "now"
 * at the trailing edge. It is drawn once a second on a small canvas; there is no chart library and
 * nothing is stored.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import "../console-strings";
import { ARC_CAP, type ArcSample, nightArc } from "../../state/night-arc";

const SECTION_COLOURS: Record<string, string> = {
  intro: "#4b5563",
  build: "#b98a2f",
  drop: "#c2410c",
  break: "#1d4ed8",
  body: "#374151",
  outro: "#4b5563",
  none: "#22262e",
};

const formatClock = (at: number): string => {
  const date = new Date(at);
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
};

function draw(canvas: HTMLCanvasElement, samples: readonly ArcSample[]): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  if (!samples.length) return;
  // "Now" is the trailing edge and the hour runs back from it, so the band is alive from the
  // first minute and never rescales as the night goes on.
  const step = width / ARC_CAP;
  const xOf = (index: number) => width - (samples.length - index) * step;
  for (const [index, sample] of samples.entries()) {
    const bar = Math.max(1, sample.energy * height);
    context.fillStyle = SECTION_COLOURS[sample.section] ?? "#22262e";
    context.globalAlpha = sample.trackId ? 0.95 : 0.35;
    context.fillRect(xOf(index), height - bar, Math.max(1, step + 0.6), bar);
  }
  context.globalAlpha = 1;
  context.fillStyle = "#7d8590";
  for (const [index, sample] of samples.entries())
    if (sample.boundary) context.fillRect(xOf(index), 0, Math.max(1, dpr), height);
  context.fillStyle = "#5beb8a";
  context.fillRect(width - Math.max(1, dpr), 0, Math.max(1, dpr), height);
}

export function EnergyArc() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [count, setCount] = useState(nightArc.length);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      draw(canvas, nightArc.samples);
      setCount(nightArc.length);
    };
    paint();
    // Once a second is plenty: the arc moves one pixel every two seconds.
    const timer = setInterval(paint, 1000);
    return () => clearInterval(timer);
  }, []);

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const fromRight = Math.round((1 - (event.clientX - bounds.left) / bounds.width) * ARC_CAP);
    const sample = nightArc.samples[nightArc.samples.length - 1 - fromRight];
    setHover(
      sample
        ? `${formatClock(sample.t)} · ${t(`section.${sample.section === "none" ? "body" : sample.section}`)} · ${Math.round(sample.energy * 10)}/10`
        : null,
    );
  };

  return (
    <div className="night-arc" data-testid="night-arc" data-samples={count} title={hover ?? undefined}>
      <canvas
        ref={canvasRef}
        className="night-arc__canvas"
        role="img"
        aria-label={t("arc.label", { count })}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <span className="night-arc__tip" role="status">
          {hover}
        </span>
      )}
    </div>
  );
}
