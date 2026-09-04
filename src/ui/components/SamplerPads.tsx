import { type DragEvent, useRef } from "react";
import { t } from "../../app/i18n-core";
import { samplerActions } from "../../engine/actions";
import { SAMPLER_SLOTS, useSampler } from "../../engine/sampler";

export function SamplerPads() {
  const { slots } = useSampler();
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<number>(0);

  const pick = (slot: number) => {
    pending.current = slot;
    fileInput.current?.click();
  };

  const onDrop = async (slot: number, event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) await samplerActions.load(slot, file, file.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div className="sampler" data-testid="sampler">
      <div className="sampler__pads">
        {Array.from({ length: SAMPLER_SLOTS }, (_, slot) => {
          const state = slots[slot];
          const loaded = Boolean(state?.name);
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: pads are positional slots
              key={slot}
              type="button"
              className={`pad pad--sample${loaded ? " pad--set" : ""}${state?.playing ? " pad--playing" : ""}`}
              onClick={() => void (loaded ? samplerActions.trigger(slot) : pick(slot))}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => void onDrop(slot, event)}
              title={loaded ? t("sampler.play", { name: state?.name ?? "" }) : t("sampler.load")}
              data-testid={`sample-${slot + 1}`}
            >
              <span className="pad__n">{slot + 1}</span>
              <span className="pad__name">{state?.name ?? t("sampler.empty")}</span>
            </button>
          );
        })}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.aiff"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void samplerActions.load(pending.current, file, file.name.replace(/\.[^.]+$/, ""));
          event.target.value = "";
        }}
      />
    </div>
  );
}
