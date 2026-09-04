/**
 * MIDI controller setup: turn it on, then teach it. Click a control, move the hardware, done —
 * the mapping is saved against that controller's own name and is there the next time it is
 * plugged in. Browsers without Web MIDI get a calm sentence, not a broken switch.
 */
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { t } from "../../app/i18n-core";
import "../console-strings";
import { MIDI_TARGETS, type MidiBinding } from "../../midi/mapping";
import { disableMidi, enableMidi, forget, learn, useMidi } from "../../midi/router";

interface MidiSetupProps {
  open: boolean;
  onClose(): void;
}

const describe = (binding: MidiBinding | undefined): string =>
  binding ? `${binding.kind === "cc" ? "CC" : "Note"} ${binding.number} · ch ${binding.channel + 1}` : "";

export function MidiSetup({ open, onClose }: MidiSetupProps) {
  const state = useMidi();
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const port = state.ports[0] ?? null;
  const map = port ? (state.maps[port] ?? {}) : {};

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      learn(null);
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    learn(null);
    onClose();
    returnFocusRef.current?.focus?.();
  };

  const groups = ["mixer", "deck", "stage"] as const;

  return (
    <div className="midi-layer">
      <button
        type="button"
        className="recap-backdrop"
        aria-label={t("keys.close")}
        onClick={close}
        data-testid="midi-backdrop"
      />
      <div
        className="midi"
        role="dialog"
        aria-modal="true"
        aria-label={t("midi.title")}
        data-testid="midi-setup"
        data-status={state.status}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <header className="midi__head">
          <h2 className="midi__title">{t("midi.title")}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label={t("keys.close")}
            onClick={close}
            data-testid="midi-close"
          >
            <X size={16} />
          </button>
        </header>

        <label className="midi__switch">
          <input
            type="checkbox"
            checked={state.status === "on"}
            onChange={(event) => {
              if (event.target.checked) void enableMidi();
              else disableMidi();
            }}
            data-testid="midi-enable"
          />
          <span>{t("midi.enable")}</span>
        </label>

        {state.status === "unsupported" && <p className="midi__note">{t("midi.unsupported")}</p>}
        {state.status === "denied" && <p className="midi__note">{t("midi.denied")}</p>}
        {state.status === "on" && (
          <p className="midi__note" data-testid="midi-ports">
            {state.ports.length ? t("midi.ports", { names: state.ports.join(", ") }) : t("midi.noPorts")}
          </p>
        )}
        <p className="midi__note midi__note--quiet">{t("midi.privacy")}</p>
        {state.lastMessage && (
          <p className="midi__last num" data-testid="midi-last">
            {state.lastMessage}
          </p>
        )}

        {state.status === "on" && (
          <div className="midi__list">
            {groups.map((group) => (
              <section key={group}>
                <h3 className="label">{t(`midi.group.${group}`)}</h3>
                <ul>
                  {MIDI_TARGETS.filter((target) => target.group === group).map((target) => {
                    const binding = map[target.id];
                    const learning = state.learning === target.id;
                    const index = target.id.split(".").at(-1) ?? "";
                    const numbered = /^\d+$/.test(index) ? Number(index) + 1 : null;
                    return (
                      <li key={target.id} className="midi__row">
                        <span className="midi__name">
                          {t(target.label)}
                          {target.deck ? ` ${target.deck}` : ""}
                          {numbered === null ? "" : ` ${numbered}`}
                        </span>
                        <span className="midi__binding num">{describe(binding)}</span>
                        <button
                          type="button"
                          className={learning ? "btn-primary" : ""}
                          aria-pressed={learning}
                          onClick={() => learn(learning ? null : target.id)}
                          data-testid={`midi-learn-${target.id}`}
                        >
                          {learning ? t("midi.listening") : t("midi.learn")}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t("midi.forget", { name: t(target.label) })}
                          disabled={!binding || !port}
                          onClick={() => port && forget(port, target.id)}
                        >
                          <X size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
