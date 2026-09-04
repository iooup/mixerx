/** The Face scene's SVG layer, updated per frame from the Director's intent (no React re-renders). */
import { type Ref, useImperativeHandle, useRef } from "react";
import type { Intent } from "../director";
import { facePose, initialFaceState, mouthPath } from "./face-math";

export interface FaceHandle {
  update(intent: Intent, dt: number): void;
}

const VIEW_W = 1600;
const VIEW_H = 900;

export function Face({ ref, visible }: { ref?: Ref<FaceHandle>; visible: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const eyeLRef = useRef<SVGEllipseElement>(null);
  const eyeRRef = useRef<SVGEllipseElement>(null);
  const pupilLRef = useRef<SVGCircleElement>(null);
  const pupilRRef = useRef<SVGCircleElement>(null);
  const browLRef = useRef<SVGPathElement>(null);
  const browRRef = useRef<SVGPathElement>(null);
  const mouthRef = useRef<SVGPathElement>(null);
  const cheekLRef = useRef<SVGCircleElement>(null);
  const cheekRRef = useRef<SVGCircleElement>(null);
  const displaceRef = useRef<SVGFEDisplacementMapElement>(null);
  const timeRef = useRef(0);
  const stateRef = useRef(initialFaceState());

  useImperativeHandle(ref, () => ({
    update(intent: Intent, dt: number) {
      const svg = svgRef.current;
      if (!svg) return;
      const freeze = intent.freeze > 0.5;
      timeRef.current += dt * (freeze ? 0.05 : 1);
      const pose = facePose(
        {
          t: timeRef.current,
          beatPhase: intent.beat.phase,
          barPhase: intent.beat.barPhase,
          kick: intent.audio.kick,
          snare: intent.audio.snare,
          hat: intent.audio.hat,
          bass: intent.audio.bass,
          snareCount: intent.beat.snareCount,
          intensity: intent.intensity,
          motion: intent.motion,
          section: intent.section,
          barsToNext: intent.barsToNext,
          burst: intent.burst,
          floor: intent.floor,
          freeze: intent.freeze,
          balance: intent.balance,
          reduced: intent.reducedMotion,
        },
        stateRef.current,
      );
      svg.style.setProperty("--face-a", intent.palette.cssA);
      svg.style.setProperty("--face-b", intent.palette.cssB);
      svg.style.setProperty("--face-accent", intent.palette.cssAccent);
      svg.style.setProperty("--face-flash", intent.flash.toFixed(3));
      svg.style.setProperty("--face-glow", (0.4 + 0.6 * intent.intensity).toFixed(3));
      const thin = Math.max(0, intent.tunnel);
      svg.style.setProperty("--face-stroke", (14 - 8 * thin).toFixed(2));
      displaceRef.current?.setAttribute("scale", (Math.max(0, -intent.tunnel) * 40).toFixed(1));
      headRef.current?.setAttribute(
        "transform",
        `translate(${(VIEW_W / 2 + pose.x).toFixed(1)} ${(VIEW_H / 2 + 20 + pose.y).toFixed(1)}) rotate(${pose.tilt.toFixed(2)}) scale(${pose.scale.toFixed(3)})`,
      );
      const eyeRy = (46 * pose.eyeOpen).toFixed(1);
      const eyeRx = (46 * (0.9 + 0.1 * Math.min(1, pose.eyeOpen))).toFixed(1);
      for (const eye of [eyeLRef.current, eyeRRef.current]) {
        eye?.setAttribute("ry", eyeRy);
        eye?.setAttribute("rx", eyeRx);
      }
      const pupilR = (18 * Math.min(1, pose.eyeOpen + 0.2)).toFixed(1);
      pupilLRef.current?.setAttribute("cx", (-120 + pose.pupilX).toFixed(1));
      pupilLRef.current?.setAttribute("cy", (-60 + pose.pupilY).toFixed(1));
      pupilLRef.current?.setAttribute("r", pupilR);
      pupilLRef.current?.setAttribute("opacity", pose.eyeOpen < 0.15 ? "0" : "1");
      pupilRRef.current?.setAttribute("cx", (120 + pose.pupilX).toFixed(1));
      pupilRRef.current?.setAttribute("cy", (-60 + pose.pupilY).toFixed(1));
      pupilRRef.current?.setAttribute("r", pupilR);
      pupilRRef.current?.setAttribute("opacity", pose.eyeOpen < 0.15 ? "0" : "1");
      const browY = -150 - pose.browRaise * 40;
      const tilt = pose.browTilt;
      browLRef.current?.setAttribute(
        "d",
        `M-175 ${(browY + tilt * 1.2).toFixed(1)} Q-120 ${(browY - 22 + tilt).toFixed(1)} -65 ${(browY - tilt * 1.2).toFixed(1)}`,
      );
      browRRef.current?.setAttribute(
        "d",
        `M65 ${(browY - tilt * 1.2).toFixed(1)} Q120 ${(browY - 22 + tilt).toFixed(1)} 175 ${(browY + tilt * 1.2).toFixed(1)}`,
      );
      mouthRef.current?.setAttribute("d", mouthPath(pose));
      mouthRef.current?.setAttribute("transform", "translate(0 110)");
      for (const cheek of [cheekLRef.current, cheekRRef.current])
        cheek?.setAttribute("opacity", (pose.cheekGlow * 0.55).toFixed(3));
    },
  }));

  return (
    <svg
      ref={svgRef}
      className="face"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      data-testid="face"
      data-visible={visible}
    >
      <defs>
        <filter id="face-melt" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.01 0.016"
            numOctaves="2"
            seed="9"
            result="noise"
          />
          <feDisplacementMap
            ref={displaceRef}
            in="SourceGraphic"
            in2="noise"
            scale="0"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
      <g ref={headRef} className="face__head" filter="url(#face-melt)">
        <path
          className="face__outline"
          d="M-300 -60 C-300 -270 -160 -330 0 -330 C160 -330 300 -270 300 -60 C300 130 200 290 0 300 C-200 290 -300 130 -300 -60 Z"
        />
        <circle ref={cheekLRef} className="face__cheek" cx="-190" cy="40" r="46" />
        <circle ref={cheekRRef} className="face__cheek face__cheek--b" cx="190" cy="40" r="46" />
        <ellipse ref={eyeLRef} className="face__eye" cx="-120" cy="-60" rx="46" ry="46" />
        <ellipse ref={eyeRRef} className="face__eye face__eye--b" cx="120" cy="-60" rx="46" ry="46" />
        <circle ref={pupilLRef} className="face__pupil" cx="-120" cy="-60" r="18" />
        <circle ref={pupilRRef} className="face__pupil" cx="120" cy="-60" r="18" />
        <path ref={browLRef} className="face__brow" d="M-175 -150 Q-120 -172 -65 -150" />
        <path ref={browRRef} className="face__brow face__brow--b" d="M65 -150 Q120 -172 175 -150" />
        <path className="face__nose" d="M0 -30 L-16 40 L14 40" />
        <path
          ref={mouthRef}
          className="face__mouth"
          d="M-120 0 Q0 -20 120 0 Q0 30 -120 0 Z"
          transform="translate(0 110)"
        />
      </g>
    </svg>
  );
}
