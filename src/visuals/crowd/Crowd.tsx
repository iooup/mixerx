/**
 * The Crowd layer: SVG dancers over the WebGPU scene, driven per frame from the Director's intent
 * without React re-renders. It reacts to the same things the scenes do — palette, drops (jump +
 * sparks), LOW kill (the floor vanishes and the crowd floats), filter sweeps (melt / thin outline),
 * the crossfader (colour split and drift), loops (time freeze), flashes — and it keeps dancing when
 * WebGPU is unavailable, so the Stage is never a blank screen.
 */
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { Intent } from "../director";
import {
  BODY,
  type DancerSeed,
  dancerPose,
  handPoint,
  hasPhone,
  makeCrowd,
  type Point,
  phoneTarget,
  sparkPoints,
} from "./crowd-math";

export interface CrowdHandle {
  update(intent: Intent, dt: number): void;
}

interface CrowdProps {
  count: number;
  ref?: Ref<CrowdHandle>;
}

const VIEW_W = 1600;
const VIEW_H = 900;
const FLOOR_Y = VIEW_H - 70;
const RIBBON_LENGTH = 16;
const SPARKS = 20;
const SPARK_IDS = Array.from({ length: SPARKS }, (_, i) => `spark-${i}`);

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Polyline for a two-segment limb from `root`, angles in degrees (0 = hanging down). */
function limbPath(
  root: Point,
  side: -1 | 1,
  upper: number,
  lower: number,
  angle1: number,
  bend: number,
): string {
  const a1 = rad(angle1) * side;
  const kx = root.x + Math.sin(a1) * upper;
  const ky = root.y + Math.cos(a1) * upper;
  const a2 = a1 + rad(bend) * side;
  const ex = kx + Math.sin(a2) * lower;
  const ey = ky + Math.cos(a2) * lower;
  return `M${root.x.toFixed(1)} ${root.y.toFixed(1)}L${kx.toFixed(1)} ${ky.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

function legPath(root: Point, hip: number, knee: number): string {
  // Legs hang down: the hip angle swings forward/back (screen x), the knee bends backward.
  const a1 = rad(hip);
  const kx = root.x + Math.sin(a1) * BODY.thigh;
  const ky = root.y + Math.cos(a1) * BODY.thigh;
  const a2 = a1 - rad(knee) * 0.6;
  const fx = kx + Math.sin(a2) * BODY.shin;
  const fy = ky + Math.cos(a2) * BODY.shin;
  return `M${root.x.toFixed(1)} ${root.y.toFixed(1)}L${kx.toFixed(1)} ${ky.toFixed(1)}L${fx.toFixed(1)} ${fy.toFixed(1)}`;
}

interface DancerRefs {
  group: SVGGElement;
  body: SVGGElement;
  head: SVGCircleElement;
  torso: SVGPathElement;
  armL: SVGPathElement;
  armR: SVGPathElement;
  legL: SVGPathElement;
  legR: SVGPathElement;
  phone: SVGRectElement | null;
  cone: SVGPathElement | null;
}

export function Crowd({ count, ref }: CrowdProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dancersRef = useRef<Map<number, DancerRefs>>(new Map());
  const displaceRef = useRef<SVGFEDisplacementMapElement>(null);
  const floorRef = useRef<SVGRectElement>(null);
  const sparksRef = useRef<SVGGElement>(null);
  const ribbonLRef = useRef<SVGPathElement>(null);
  const ribbonRRef = useRef<SVGPathElement>(null);
  const timeRef = useRef(0);
  const sparkSeedRef = useRef(1);
  const phoneRef = useRef(0);
  const phraseAgeRef = useRef(999);
  const lastPhraseRef = useRef(-1);
  const mirrorRef = useRef<SVGGElement>(null);
  const ribbons = useRef<{ left: Point[]; right: Point[] }>({ left: [], right: [] });
  const dancers = useMemo(() => {
    const seeds = makeCrowd(count);
    return [...seeds].sort((a, b) => b.depth - a.depth); // back to front
  }, [count]);

  useEffect(() => {
    ribbons.current = { left: [], right: [] };
  }, []);

  useImperativeHandle(ref, () => ({
    update(intent: Intent, dt: number) {
      const svg = svgRef.current;
      if (!svg) return;
      const freeze = intent.freeze > 0.5;
      timeRef.current += dt * (freeze ? 0.05 : 1);
      const t = timeRef.current;
      const barSec = intent.beat.bpm > 0 ? (60 / intent.beat.bpm) * 4 : 2;
      // Phones rise as soon as the break starts and take one bar to come back down.
      const phoneWanted = phoneTarget(intent.section);
      phoneRef.current +=
        (phoneWanted - phoneRef.current) * (1 - Math.exp(-dt / (phoneWanted > 0.5 ? 0.25 : barSec / 3)));
      if (intent.beat.phraseIndex !== lastPhraseRef.current) {
        lastPhraseRef.current = intent.beat.phraseIndex;
        phraseAgeRef.current = 0;
      } else {
        phraseAgeRef.current += freeze ? 0 : dt;
      }
      svg.style.setProperty("--crowd-a", intent.palette.cssA);
      svg.style.setProperty("--crowd-b", intent.palette.cssB);
      svg.style.setProperty("--crowd-accent", intent.palette.cssAccent);
      svg.style.setProperty("--crowd-flash", intent.flash.toFixed(3));
      svg.style.setProperty("--crowd-intensity", (0.55 + 0.45 * intent.intensity).toFixed(3));
      const thin = Math.max(0, intent.tunnel);
      svg.style.setProperty("--limb-width", (10 - 6 * thin).toFixed(2));
      svg.style.setProperty("--limb-opacity", (1 - 0.25 * thin).toFixed(3));
      const melt = Math.max(0, -intent.tunnel);
      displaceRef.current?.setAttribute("scale", (melt * 45).toFixed(1));
      floorRef.current?.setAttribute("opacity", (intent.floor * 0.9).toFixed(3));
      // A rim light in the accent colour: the crowd is lit by the scene behind it.
      svg.style.setProperty("--crowd-rim", `${(2 + 10 * intent.intensity).toFixed(1)}px`);
      // Floor reflection: mirrored and blurred under the dancers, gone when the LOW is killed.
      const reflect = intent.reducedMotion ? 0 : intent.floor * 0.3;
      svg.style.setProperty("--crowd-reflect", reflect.toFixed(3));
      mirrorRef.current?.setAttribute("data-on", reflect > 0.02 ? "true" : "false");
      const split = 0.5 + (0.5 - intent.balance) * 0.9;
      const drift = (intent.balance - 0.5) * 160;
      const input = {
        t,
        beatPhase: intent.beat.phase,
        barPhase: intent.beat.barPhase,
        kick: intent.audio.kick,
        snare: intent.audio.snare,
        hat: intent.audio.hat,
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
        anticipation: intent.anticipation,
        phone: phoneRef.current,
        phraseAge: phraseAgeRef.current,
        barSec,
        // The wave starts on the side that is on air: deck A is the left of the floor.
        waveFromLeft: intent.balance < 0.5,
      };
      let leadPose: ReturnType<typeof dancerPose> | null = null;
      let leadSeed: DancerSeed | null = null;
      let leadX = VIEW_W / 2;
      let leadY = FLOOR_Y;
      for (const seed of dancers) {
        const refs = dancersRef.current.get(seed.id);
        if (!refs) continue;
        const pose = dancerPose(seed, input);
        const x = 80 + seed.slot * (VIEW_W - 160) + drift;
        const ground = FLOOR_Y - seed.depth * 150;
        refs.group.setAttribute("transform", `translate(${x.toFixed(1)} ${ground.toFixed(1)})`);
        refs.group.setAttribute("data-side", seed.slot < split ? "a" : "b");
        refs.group.style.opacity = pose.opacity.toFixed(3);
        refs.body.setAttribute(
          "transform",
          `translate(0 ${pose.y.toFixed(1)}) scale(${pose.scale.toFixed(3)}) rotate(${pose.lean.toFixed(2)} 0 ${BODY.hipY})`,
        );
        refs.head.setAttribute("cy", (BODY.headY + pose.headBob).toFixed(1));
        refs.head.setAttribute("cx", (pose.hipShift * 0.3).toFixed(1));
        refs.torso.setAttribute(
          "d",
          `M${(pose.hipShift * 0.6).toFixed(1)} ${BODY.hipY}L${(pose.hipShift * 0.3).toFixed(1)} ${BODY.neckY}`,
        );
        const shoulderL = { x: -BODY.shoulderX + pose.hipShift * 0.3, y: BODY.neckY + 6 };
        const shoulderR = { x: BODY.shoulderX + pose.hipShift * 0.3, y: BODY.neckY + 6 };
        refs.armL.setAttribute(
          "d",
          limbPath(shoulderL, -1, BODY.upperArm, BODY.foreArm, pose.armL, pose.elbowL),
        );
        refs.armR.setAttribute(
          "d",
          limbPath(shoulderR, 1, BODY.upperArm, BODY.foreArm, pose.armR, pose.elbowR),
        );
        const hipL = { x: -BODY.hipX + pose.hipShift * 0.6, y: BODY.hipY };
        const hipR = { x: BODY.hipX + pose.hipShift * 0.6, y: BODY.hipY };
        refs.legL.setAttribute("d", legPath(hipL, pose.legL, pose.kneeL));
        refs.legR.setAttribute("d", legPath(hipR, pose.legR, pose.kneeR));
        if (refs.phone && refs.cone) {
          if (pose.phone > 0.01) {
            const hand = handPoint(pose, -1);
            refs.phone.setAttribute("x", (hand.x - 5).toFixed(1));
            refs.phone.setAttribute("y", (hand.y - 9).toFixed(1));
            refs.phone.setAttribute("opacity", pose.phone.toFixed(3));
            // A soft cone of light from the screen, widening upward.
            refs.cone.setAttribute(
              "d",
              `M${(hand.x - 4).toFixed(1)} ${(hand.y - 9).toFixed(1)}L${(hand.x - 26).toFixed(1)} ${(hand.y - 76).toFixed(1)}L${(hand.x + 26).toFixed(1)} ${(hand.y - 76).toFixed(1)}L${(hand.x + 4).toFixed(1)} ${(hand.y - 9).toFixed(1)}Z`,
            );
            refs.cone.setAttribute("opacity", (pose.phone * 0.22).toFixed(3));
          } else {
            refs.phone.setAttribute("opacity", "0");
            refs.cone.setAttribute("opacity", "0");
          }
        }
        if (seed.personality === "lead") {
          leadPose = pose;
          leadSeed = seed;
          leadX = x;
          leadY = ground;
        }
      }
      // Ribbons trail the lead dancer's hands.
      if (leadPose && leadSeed) {
        const pose = leadPose;
        const toWorld = (p: Point): Point => ({
          x: leadX + p.x * pose.scale,
          y: leadY + pose.y + p.y * pose.scale,
        });
        const left = toWorld(handPoint(pose, -1));
        const right = toWorld(handPoint(pose, 1));
        const push = (list: Point[], point: Point) => {
          list.push(point);
          while (list.length > RIBBON_LENGTH) list.shift();
        };
        if (!freeze) {
          push(ribbons.current.left, left);
          push(ribbons.current.right, right);
        }
        const path = (list: Point[]) =>
          list.length < 2 ? "" : `M${list.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L")}`;
        ribbonLRef.current?.setAttribute("d", path(ribbons.current.left));
        ribbonRRef.current?.setAttribute("d", path(ribbons.current.right));
        const ribbonOpacity = (0.35 + 0.65 * intent.intensity) * (intent.reducedMotion ? 0.5 : 1);
        ribbonLRef.current?.setAttribute("opacity", ribbonOpacity.toFixed(3));
        ribbonRRef.current?.setAttribute("opacity", ribbonOpacity.toFixed(3));
      }
      // Sparks burst from the crowd on a drop.
      const sparks = sparksRef.current;
      if (sparks) {
        if (intent.burst > 0.97) sparkSeedRef.current = intent.beat.barIndex + intent.seed;
        const points = sparkPoints(intent.reducedMotion ? 0 : intent.burst, sparkSeedRef.current, SPARKS);
        const circles = sparks.children;
        for (let i = 0; i < circles.length; i += 1) {
          const circle = circles[i] as SVGCircleElement;
          const point = points[i];
          if (!point) {
            circle.setAttribute("opacity", "0");
            continue;
          }
          circle.setAttribute("cx", (VIEW_W / 2 + drift + point.x).toFixed(1));
          circle.setAttribute("cy", (FLOOR_Y - 120 + point.y).toFixed(1));
          circle.setAttribute("opacity", point.alpha.toFixed(3));
        }
      }
    },
  }));

  const register = (id: number) => (element: SVGGElement | null) => {
    if (!element) {
      dancersRef.current.delete(id);
      return;
    }
    const q = <T extends Element>(selector: string) => element.querySelector(selector) as T;
    dancersRef.current.set(id, {
      group: element,
      body: q<SVGGElement>(".dancer__body"),
      head: q<SVGCircleElement>(".dancer__head"),
      torso: q<SVGPathElement>(".dancer__torso"),
      armL: q<SVGPathElement>(".dancer__arm--l"),
      armR: q<SVGPathElement>(".dancer__arm--r"),
      legL: q<SVGPathElement>(".dancer__leg--l"),
      legR: q<SVGPathElement>(".dancer__leg--r"),
      phone: element.querySelector(".dancer__phone"),
      cone: element.querySelector(".dancer__cone"),
    });
  };

  return (
    <svg
      ref={svgRef}
      className="crowd"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      data-testid="crowd"
      data-count={dancers.length}
    >
      <defs>
        <filter id="crowd-melt" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.02"
            numOctaves="2"
            seed="4"
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
        <linearGradient id="crowd-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--crowd-accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--crowd-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect
        ref={floorRef}
        className="crowd__floor"
        x="0"
        y={FLOOR_Y - 2}
        width={VIEW_W}
        height="120"
        fill="url(#crowd-floor)"
      />
      {/* Reflection: the same dancers mirrored in the floor, blurred and faint, gone with the LOW. */}
      <g
        ref={mirrorRef}
        className="crowd__mirror"
        data-on="false"
        transform={`translate(0 ${FLOOR_Y * 2}) scale(1 -1)`}
      >
        <use href="#crowd-dancers" />
      </g>
      <g className="crowd__ribbons">
        <path ref={ribbonLRef} className="crowd__ribbon" />
        <path ref={ribbonRRef} className="crowd__ribbon crowd__ribbon--b" />
      </g>
      <g className="crowd__melt" filter="url(#crowd-melt)">
        <g id="crowd-dancers" className="crowd__dancers">
          {dancers.map((seed) => (
            <g
              key={seed.id}
              ref={register(seed.id)}
              className={`dancer dancer--${seed.personality}`}
              data-id={seed.id}
            >
              <g className="dancer__body">
                <path className="dancer__limb dancer__leg dancer__leg--l" />
                <path className="dancer__limb dancer__leg dancer__leg--r" />
                <path className="dancer__limb dancer__torso" />
                <path className="dancer__limb dancer__arm dancer__arm--l" />
                <path className="dancer__limb dancer__arm dancer__arm--r" />
                <circle className="dancer__head" r={BODY.headR} cx="0" cy={BODY.headY} />
                {hasPhone(seed) && (
                  <>
                    <path className="dancer__cone" opacity="0" />
                    <rect className="dancer__phone" width="10" height="18" rx="2.5" opacity="0" />
                  </>
                )}
              </g>
            </g>
          ))}
        </g>
      </g>
      <g ref={sparksRef} className="crowd__sparks">
        {SPARK_IDS.map((id, i) => (
          <circle key={id} className="crowd__spark" r={i % 3 === 0 ? 6 : 4} opacity="0" />
        ))}
      </g>
    </svg>
  );
}
