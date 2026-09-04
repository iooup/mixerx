import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CrowdHandle } from "./Crowd";
import { type CrowdLayout, type CrowdStyle, PET_IDS, type PetId } from "./characters";
import { PET_ASSETS, PET_CELL } from "./pet-assets";
import { PET_STAGE_HEIGHT, petFormation } from "./pet-formation";
import { PetMotion, type PetPose } from "./pet-motion";

interface Props {
  character: Exclude<CrowdStyle, "classic">;
  layout: CrowdLayout;
  ref?: Ref<CrowdHandle>;
}

// Four decoded local sheets at most, shared across character/count changes in this window.
const sheets = new Map<PetId, Promise<HTMLImageElement>>();
function loadSheet(id: PetId): Promise<HTMLImageElement> {
  let promise = sheets.get(id);
  if (!promise) {
    promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => {
        sheets.delete(id);
        reject(new Error(`Pet image unavailable: ${id}`));
      };
      image.src = PET_ASSETS[id];
    });
    sheets.set(id, promise);
  }
  return promise;
}

/** A sprite overlay driven by the existing Stage loop, with a responsive, bounded formation. */
export function PetCrowd({ character, layout, ref }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const images = useRef(new Map<PetId, HTMLImageElement>());
  const motion = useRef(new PetMotion());
  const [assetState, setAssetState] = useState<"loading" | "ready" | "error">("loading");
  const [dimensions, setDimensions] = useState({ width: 1, height: 1, dpr: 1 });
  const dancers = useMemo(
    () => petFormation(character, layout, dimensions.width / dimensions.height),
    [character, layout, dimensions.width, dimensions.height],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    contextRef.current = canvas.getContext("2d");
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      setDimensions({ width: Math.max(1, box.width), height: Math.max(1, box.height), dpr });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    motion.current.configure(character, layout.count);
  }, [character, layout.count]);

  useEffect(() => {
    let active = true;
    setAssetState("loading");
    const needed = character === "mixed" ? PET_IDS : [character];
    void Promise.all(
      needed.map(async (id) => {
        const image = await loadSheet(id);
        if (active) images.current.set(id, image);
      }),
    ).then(
      () => {
        if (active) setAssetState("ready");
      },
      () => {
        if (active) setAssetState("error");
      },
    );
    return () => {
      active = false;
    };
  }, [character]);

  useImperativeHandle(ref, () => ({
    update(intent, dt) {
      const ctx = contextRef.current;
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!intent.crowd || intent.blackout) return;
      const { width, height, dpr } = dimensions;
      const scale = height / PET_STAGE_HEIGHT;
      const stageWidth = width / scale;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const resting = intent.onAir === "none" || intent.reducedMotion;
      const drift = resting || intent.freeze > 0.5 ? 0 : (intent.balance - 0.5) * 32;
      let firstPose: PetPose | undefined;
      for (const dancer of dancers) {
        const image = images.current.get(dancer.character);
        if (!image) continue;
        const { seed, size, ground } = dancer;
        const pose = motion.current.update(dancer.character, seed, intent, dt);
        if (seed.id === 0) firstPose = pose;
        const edge = 130 * size;
        const x = Math.max(edge, Math.min(stageWidth - edge, dancer.x + (drift + pose.x) * size));
        const floating = resting ? 0 : (1 - intent.floor) * 30;
        const alpha = 1 - seed.depth * 0.25;
        const draw = () =>
          ctx.drawImage(
            image,
            pose.column * PET_CELL.width,
            pose.row * PET_CELL.height,
            PET_CELL.width,
            PET_CELL.height,
            -96,
            -196,
            192,
            208,
          );
        if (intent.floor > 0.05) {
          ctx.save();
          ctx.globalAlpha = 0.22 * intent.floor * alpha;
          ctx.fillStyle = seed.slot < 0.5 ? intent.palette.cssA : intent.palette.cssB;
          ctx.beginPath();
          ctx.ellipse(x, ground + 3, 46 * size, 7 * size, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        if (!intent.reducedMotion && intent.floor > 0.05) {
          ctx.save();
          ctx.globalAlpha = 0.09 * intent.floor * alpha;
          ctx.translate(x, ground + 15 - pose.y * size * 0.32);
          ctx.scale(size * pose.stretch, (-size * 0.26) / pose.stretch);
          ctx.rotate(pose.lean);
          draw();
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, ground + (pose.y - floating) * size);
        ctx.scale(size * pose.stretch, size / pose.stretch);
        ctx.rotate(pose.lean);
        draw();
        ctx.restore();
      }
      const cell = firstPose ? `${firstPose.row}:${firstPose.column}` : "0:0";
      if (canvas.dataset.frame !== cell) canvas.dataset.frame = cell;
      if (firstPose && canvas.dataset.move !== firstPose.move) canvas.dataset.move = firstPose.move;
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="crowd crowd--pets"
      tabIndex={-1}
      aria-hidden="true"
      data-testid="crowd"
      data-character={character}
      data-count={dancers.length}
      data-members={character === "mixed" ? PET_IDS.join(",") : character}
      data-size={layout.size}
      data-spacing={layout.spacing}
      data-asset={assetState}
    />
  );
}
