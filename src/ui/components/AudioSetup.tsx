import { useEffect, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import { applyRouting, ensureEngine, getEngine } from "../../engine";
import { playTestTone } from "../../engine/actions";
import type { OutputDevice } from "../../engine/routing";
import type { RoutingMode } from "../../state/session";
import { useSession } from "../../state/session-store";

const MODES: RoutingMode[] = ["single", "two-devices", "split-4ch", "mono-split"];

interface AudioSetupProps {
  open: boolean;
  onClose(): void;
}

export function AudioSetup({ open, onClose }: AudioSetupProps) {
  const { routing, engine } = useSession();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<RoutingMode>(routing.mode);
  const [masterDeviceId, setMasterDeviceId] = useState(routing.masterDeviceId ?? "");
  const [cueDeviceId, setCueDeviceId] = useState(routing.cueDeviceId ?? "");
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [capabilities, setCapabilities] = useState({ setSinkId: false, maxChannels: 2 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void (async () => {
        try {
          const instance = await ensureEngine();
          setCapabilities({
            setSinkId: instance.routing.capabilities.setSinkId,
            maxChannels: instance.routing.capabilities.maxChannels,
          });
          setDevices(await instance.routing.listOutputs(false));
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      })();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    setMode(routing.mode);
    setMasterDeviceId(routing.masterDeviceId ?? "");
    setCueDeviceId(routing.cueDeviceId ?? "");
  }, [routing.mode, routing.masterDeviceId, routing.cueDeviceId]);

  const listDevices = async () => {
    const instance = await ensureEngine();
    setDevices(await instance.routing.listOutputs(true));
  };

  const apply = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const config: { mode: RoutingMode; masterDeviceId?: string; cueDeviceId?: string } = { mode };
      if (masterDeviceId) config.masterDeviceId = masterDeviceId;
      if (cueDeviceId) config.cueDeviceId = cueDeviceId;
      const state = await applyRouting(config);
      if (state.error) setMessage(state.error);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const modeAvailable = (candidate: RoutingMode): boolean => {
    if (candidate === "two-devices") return capabilities.setSinkId;
    if (candidate === "split-4ch") return capabilities.maxChannels >= 4;
    return true;
  };

  const latency = getEngine()?.routing.status().latencyMs ?? routing.latencyMs;

  return (
    <dialog
      ref={dialogRef}
      className="audio-setup"
      onClose={onClose}
      onCancel={onClose}
      data-testid="audio-setup"
    >
      <form method="dialog" className="audio-setup__form">
        <header className="audio-setup__head">
          <h2 className="audio-setup__title">{t("audio.title")}</h2>
          <span className="muted">
            {t(`engine.${engine.status}`, {
              rate: engine.sampleRate ? engine.sampleRate / 1000 : 0,
              latency: engine.latencyMs ?? 0,
              error: engine.error ?? "",
            })}
          </span>
        </header>
        <fieldset className="audio-setup__modes">
          <legend className="label">{t("audio.mode")}</legend>
          {MODES.map((candidate) => (
            <label
              key={candidate}
              className={modeAvailable(candidate) ? "audio-setup__mode" : "audio-setup__mode is-unavailable"}
            >
              <input
                type="radio"
                name="routing-mode"
                value={candidate}
                checked={mode === candidate}
                disabled={!modeAvailable(candidate)}
                onChange={() => setMode(candidate)}
              />
              <span>{t(`audio.mode.${candidate}`)}</span>
              {!modeAvailable(candidate) && <small className="muted">{t("audio.unavailable")}</small>}
            </label>
          ))}
        </fieldset>
        <div className="audio-setup__devices">
          <label>
            <span className="label">{t("audio.master")}</span>
            <select
              value={masterDeviceId}
              onChange={(event) => setMasterDeviceId(event.target.value)}
              disabled={!capabilities.setSinkId}
            >
              <option value="">{t("audio.default")}</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">{t("audio.cue")}</span>
            <select
              value={cueDeviceId}
              onChange={(event) => setCueDeviceId(event.target.value)}
              disabled={mode !== "two-devices"}
            >
              <option value="">{t("audio.default")}</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void listDevices()}>
            {t("audio.grant")}
          </button>
        </div>
        <p className="muted audio-setup__latency">
          {t("audio.latency", { master: latency.master, cue: latency.cue })}
        </p>
        <div className="audio-setup__tests">
          <button type="button" onClick={() => void playTestTone("master")}>
            {t("audio.test.master")}
          </button>
          <button type="button" onClick={() => void playTestTone("cue")}>
            {t("audio.test.cue")}
          </button>
        </div>
        {message && (
          <p className="audio-setup__message" role="alert">
            {message}
          </p>
        )}
        <footer className="audio-setup__actions">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy}
            className="btn-primary"
            data-testid="audio-apply"
          >
            {t("audio.apply")}
          </button>
          <button type="submit">{t("audio.close")}</button>
        </footer>
      </form>
    </dialog>
  );
}
