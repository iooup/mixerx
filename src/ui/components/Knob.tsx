import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
  KNOB_DRAG_PX,
  KNOB_FINE_FACTOR,
  KNOB_MIN_DEG,
  KNOB_SWEEP_DEG,
  knobAngle,
  knobValue,
  quantize,
  wheelNotch,
} from "../knob-math";

const SIZE = 40;
const CENTRE = SIZE / 2;
const RADIUS = CENTRE - 4;

function polar(deg: number, radius: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CENTRE + radius * Math.cos(rad), CENTRE + radius * Math.sin(rad)];
}

function arcPath(from: number, to: number): string {
  if (Math.abs(to - from) < 0.5) return "";
  const [x1, y1] = polar(from, RADIUS);
  const [x2, y2] = polar(to, RADIUS);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${RADIUS} ${RADIUS} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export interface KnobProps {
  /** Resting label under the knob (physical, not translated: HI, MID, LOW…). */
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Zero at 12 o'clock; the arc grows from the centre. Requires min < 0 < max. */
  bipolar?: boolean;
  /** Live readout shown while hovering, dragging, or focused; also the aria-valuetext. */
  format(value: number): string;
  onChange(value: number): void;
  /** Double-click / double-tap: kill for EQ bands, reset elsewhere. */
  onDoubleClick?(): void;
  disabled?: boolean;
  small?: boolean;
  kill?: boolean;
  title?: string;
  testId?: string;
  guideTarget?: string;
}

/**
 * A mixer knob: an SVG dial driven by vertical pointer drags (Shift = fine) and the wheel,
 * wrapping a real range input so keyboard, screen readers, the Guide, and the e2e tests
 * keep working exactly as they do for a plain slider.
 */
export function Knob({
  label,
  ariaLabel,
  value,
  min,
  max,
  step,
  bipolar = false,
  format,
  onChange,
  onDoubleClick,
  disabled = false,
  small = false,
  kill = false,
  title,
  testId,
  guideTarget,
}: KnobProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointerId: number; lastY: number; angle: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ value, min, max, step, bipolar, disabled, onChange });
  latest.current = { value, min, max, step, bipolar, disabled, onChange };

  // The wheel listener must not be passive so the page does not scroll under the knob.
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const state = latest.current;
      if (state.disabled) return;
      event.preventDefault();
      const notch = event.shiftKey ? state.step : wheelNotch(state.min, state.max, state.step);
      const next = quantize(
        state.value + (event.deltaY < 0 ? notch : -notch),
        state.min,
        state.max,
        state.step,
      );
      if (next !== state.value) state.onChange(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      lastY: event.clientY,
      angle: knobAngle(value, min, max, bipolar),
      last: value,
    };
    setDragging(true);
    inputRef.current?.focus({ preventScroll: true });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const fine = event.shiftKey ? 1 / KNOB_FINE_FACTOR : 1;
    state.angle += ((state.lastY - event.clientY) / KNOB_DRAG_PX) * KNOB_SWEEP_DEG * fine;
    state.angle = Math.min(KNOB_MIN_DEG + KNOB_SWEEP_DEG, Math.max(KNOB_MIN_DEG, state.angle));
    state.lastY = event.clientY;
    const next = quantize(knobValue(state.angle, min, max, bipolar), min, max, step);
    if (next !== state.last) {
      state.last = next;
      onChange(next);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const angle = knobAngle(value, min, max, bipolar);
  const [tipX, tipY] = polar(angle, RADIUS - 4);
  const [baseX, baseY] = polar(angle, RADIUS - 10);
  const [detentX1, detentY1] = polar(0, RADIUS + 2);
  const [detentX2, detentY2] = polar(0, RADIUS + 5);
  const className = `knob${small ? " knob--s" : ""}${disabled ? " knob--disabled" : ""}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the dial is a pointer surface; the range input inside carries the semantics and keyboard
    <div
      ref={wrapperRef}
      className={className}
      title={title}
      data-guide-target={guideTarget}
      data-dragging={dragging ? "true" : undefined}
      data-kill={kill ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => {
        if (!disabled) onDoubleClick?.();
      }}
    >
      <svg className="knob__svg" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <path className="knob__track" d={arcPath(KNOB_MIN_DEG, KNOB_MIN_DEG + KNOB_SWEEP_DEG)} />
        <path className="knob__arc" d={arcPath(bipolar ? 0 : KNOB_MIN_DEG, angle)} />
        <circle className="knob__cap" cx={CENTRE} cy={CENTRE} r={RADIUS - 5} />
        <line
          className="knob__ptr"
          x1={baseX.toFixed(2)}
          y1={baseY.toFixed(2)}
          x2={tipX.toFixed(2)}
          y2={tipY.toFixed(2)}
        />
        {bipolar && (
          <line
            className="knob__detent"
            x1={detentX1.toFixed(2)}
            y1={detentY1.toFixed(2)}
            x2={detentX2.toFixed(2)}
            y2={detentY2.toFixed(2)}
          />
        )}
      </svg>
      <input
        ref={inputRef}
        type="range"
        className="knob__input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        data-testid={testId}
      />
      <span className="knob__label">{label}</span>
      <span className="knob__value num">{format(value)}</span>
    </div>
  );
}
