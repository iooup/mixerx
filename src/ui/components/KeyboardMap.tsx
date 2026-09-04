import { useEffect, useRef } from "react";
import { t } from "../../app/i18n-core";
import { SHORTCUT_GROUPS } from "../keyboard";

export function KeyboardMap({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="keymap" onClose={onClose} onCancel={onClose} data-testid="keyboard-map">
      <form method="dialog" className="keymap__form">
        <h2 className="keymap__title">{t("keys.title")}</h2>
        <div className="keymap__groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="keymap__group">
              <h3 className="label">{t(group.title)}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.label} className="keymap__row">
                    <dt>
                      {item.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{t(item.label)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="keymap__actions">
          <button type="submit">{t("audio.close")}</button>
        </footer>
      </form>
    </dialog>
  );
}
