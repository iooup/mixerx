import { Users } from "lucide-react";
import { t } from "../../app/i18n-core";
import {
  type CrowdLayout,
  type CrowdStyle,
  DEFAULT_CROWD_LAYOUT,
  MAX_CROWD_COUNT,
  PET_IDS,
} from "../../visuals/crowd/characters";
import { PET_ASSETS } from "../../visuals/crowd/pet-assets";
import { useStageSettings } from "../../visuals/settings-store";
import type { StageClient } from "../../visuals/stage-client";
import { useStageStatus } from "../../visuals/stage-status";

const OPTIONS: CrowdStyle[] = ["classic", ...PET_IDS, "mixed"];

export function CrowdPicker({ client }: { client: StageClient }) {
  const settings = useStageSettings();
  const status = useStageStatus();
  const scene = status.sceneId && status.sceneId !== "blackout" ? status.sceneId : settings.sceneId;
  const selected = settings.crowdStyles[scene] ?? "classic";
  const layout = settings.crowdLayouts[scene] ?? DEFAULT_CROWD_LAYOUT;
  const changeLayout = (key: keyof CrowdLayout, value: number) =>
    client.patch({
      crowdLayouts: { ...settings.crowdLayouts, [scene]: { ...layout, [key]: value } },
    });
  return (
    <fieldset className="crowd-picker" data-testid="crowd-picker">
      <legend>{t("stage.crowdCharacter")}</legend>
      <div className="crowd-picker__grid">
        {OPTIONS.map((style) => (
          <label key={style} className="crowd-picker__option" data-selected={selected === style}>
            <input
              type="radio"
              name="crowd-character"
              value={style}
              checked={selected === style}
              onChange={() =>
                client.patch({
                  crowdStyles: { ...settings.crowdStyles, [scene]: style },
                  crowdScenes: settings.crowdScenes.includes(scene)
                    ? settings.crowdScenes
                    : [...settings.crowdScenes, scene],
                })
              }
              data-testid={`crowd-character-${style}`}
            />
            {style === "classic" ? (
              <Users size={30} aria-hidden="true" />
            ) : (
              <svg className="crowd-picker__portrait" viewBox="0 0 96 104" aria-hidden="true">
                {style === "mixed" ? (
                  PET_IDS.map((id, i) => (
                    <svg
                      key={id}
                      x={(i % 2) * 48}
                      y={Math.floor(i / 2) * 52}
                      width="48"
                      height="52"
                      viewBox="0 0 96 104"
                      aria-hidden="true"
                    >
                      <image href={PET_ASSETS[id]} width="768" height="520" />
                    </svg>
                  ))
                ) : (
                  <image href={PET_ASSETS[style]} width="768" height="520" />
                )}
              </svg>
            )}
            <span>{t(`stage.pet.${style}`)}</span>
          </label>
        ))}
      </div>
      <p>{t("stage.crowdCharacterHint")}</p>
      {selected !== "classic" && (
        <details className="crowd-picker__formation" data-testid="crowd-formation">
          <summary>{t("stage.crowdFormation")}</summary>
          {(
            [
              { key: "count", min: 4, max: MAX_CROWD_COUNT, step: 1 },
              { key: "size", min: 0.65, max: 1.4, step: 0.05 },
              { key: "spacing", min: 0.6, max: 1.5, step: 0.05 },
            ] as const
          ).map(({ key, min, max, step }) => (
            <label key={key} htmlFor={`crowd-${key}`} className="crowd-picker__range">
              <span>{t(`stage.crowd.${key}`)}</span>
              <output htmlFor={`crowd-${key}`} className="num">
                {key === "count" ? layout[key] : `${Math.round(layout[key] * 100)} %`}
              </output>
              <input
                id={`crowd-${key}`}
                type="range"
                min={min}
                max={max}
                step={step}
                value={layout[key]}
                onChange={(event) => changeLayout(key, Number(event.target.value))}
                data-testid={`crowd-${key}`}
              />
            </label>
          ))}
          <p>{t("stage.crowdFitHint")}</p>
        </details>
      )}
    </fieldset>
  );
}
