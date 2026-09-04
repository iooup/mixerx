/**
 * Idle mode: when nothing has been on air for twenty seconds the scene eases back and this layer
 * comes up — a quiet clock in the interface's own digits, the night's name if the DJ set one, and
 * (from the night sky layer) the set so far. It is a held breath between records, not a screensaver:
 * it leaves within 300 ms the moment a deck starts or the level comes back.
 */
import { type Ref, useImperativeHandle, useMemo, useRef } from "react";
import type { Intent } from "../director";

export interface IdleHandle {
  update(intent: Intent, dt: number): void;
}

interface IdleProps {
  eventName: string;
  ref?: Ref<IdleHandle>;
}

export function IdleLayer({ eventName, ref }: IdleProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const lastMinuteRef = useRef(-1);
  const driftRef = useRef(0);
  const formatter = useMemo(
    () => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
    [],
  );

  useImperativeHandle(ref, () => ({
    update(intent, dt) {
      const root = rootRef.current;
      if (!root) return;
      const visible = intent.idle > 0.01 && !intent.blackout;
      root.style.setProperty("--idle", intent.idle.toFixed(3));
      root.setAttribute("data-visible", visible ? "true" : "false");
      if (!visible) return;
      const now = new Date();
      const minute = now.getHours() * 60 + now.getMinutes();
      if (minute !== lastMinuteRef.current && clockRef.current) {
        lastMinuteRef.current = minute;
        clockRef.current.textContent = formatter.format(now);
      }
      // A very slow drift so the pixels never sit still; reduced motion keeps it perfectly still.
      driftRef.current = intent.reducedMotion ? 0 : (driftRef.current + dt * 0.06) % (Math.PI * 2);
      const drift = driftRef.current;
      root.style.setProperty("--idle-x", `${(Math.sin(drift) * 10).toFixed(2)}px`);
      root.style.setProperty("--idle-y", `${(Math.cos(drift * 0.7) * 6).toFixed(2)}px`);
    },
  }));

  return (
    <div ref={rootRef} className="idle" data-testid="idle-layer" data-visible="false" aria-hidden="true">
      <span ref={clockRef} className="idle__clock num" data-testid="idle-clock" />
      {eventName && (
        <span className="idle__event" dir="auto">
          {eventName}
        </span>
      )}
    </div>
  );
}
