/**
 * The command palette (⌘K / Ctrl+K). One field that reaches every tool, every door in the console
 * and every track in the library — the DJ's hands stay on the keyboard through a set.
 *
 * Tools run through `registry.invoke`, so a call from here is policed, proposed and logged exactly
 * like a call from an agent. It ships in its own chunk: the console entry carries only the key.
 */
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../app/i18n-core";
import "../console-strings";
import { rank } from "../palette/matcher";
import { allCommands, type Command, type CommandContext, rememberRecent } from "../palette/sources";

interface PaletteProps {
  open: boolean;
  onClose(): void;
  context: CommandContext;
}

export function CommandPalette({ open, onClose, context }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** Set while a command is asking for its one argument. */
  const [asking, setAsking] = useState<Command | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const commands = useMemo(
    () => (open ? allCommands(context) : []),
    // The list is rebuilt each time it opens: the library, the mode and the tools all move.
    [open, context],
  );

  const results = useMemo<Command[]>(() => {
    if (!asking) return rank(query, commands);
    // Answering a prompt: the list becomes that command's own suggestions.
    const suggestions = asking.prompt?.suggestions ?? [];
    const options: Command[] = suggestions.map((entry) => ({
      id: entry.value,
      group: "console",
      label: entry.label,
      haystack: `${entry.label} ${entry.value}`,
      run: () => {},
    }));
    return rank(query, options, 20);
  }, [asking, commands, query]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    setAsking(null);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, []);

  // Keep the highlighted row in view without scrolling the page.
  useEffect(() => {
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const close = () => {
    onClose();
    returnFocusRef.current?.focus?.();
  };

  const choose = (index: number, modifier: boolean) => {
    const chosen = results[index];
    if (!chosen) return;
    if (asking) {
      const command = asking;
      setAsking(null);
      rememberRecent(command.id);
      void command.run(chosen.id, modifier);
      close();
      return;
    }
    if (chosen.prompt) {
      setAsking(chosen);
      setQuery("");
      setActive(0);
      return;
    }
    rememberRecent(chosen.id);
    void chosen.run("", modifier);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (asking) {
        setAsking(null);
        setQuery("");
        return;
      }
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (asking && !asking.prompt?.suggestions?.length) {
        const command = asking;
        setAsking(null);
        rememberRecent(command.id);
        void command.run(query, event.metaKey || event.ctrlKey);
        close();
        return;
      }
      choose(active, event.metaKey || event.ctrlKey);
    }
  };

  const groupLabel = (group: Command["group"]) => t(`palette.group.${group}`);

  return (
    <div className="palette-layer">
      {/* A real button, so clicking away has a name and a keyboard equivalent of its own. */}
      <button
        type="button"
        className="palette-backdrop"
        aria-label={t("keys.close")}
        onClick={close}
        data-testid="palette-backdrop"
      />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        data-testid="palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette__field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="palette__input"
            value={query}
            dir="auto"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-option-${active}` : undefined}
            aria-label={asking?.prompt?.label ?? t("palette.title")}
            placeholder={asking?.prompt?.label ?? t("palette.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            data-testid="palette-input"
          />
          <kbd>Esc</kbd>
        </div>
        <div
          id="palette-list"
          ref={listRef}
          className="palette__list"
          role="listbox"
          data-testid="palette-list"
        >
          {results.map((command, index) => (
            <button
              key={command.id}
              type="button"
              id={`palette-option-${index}`}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              className="palette__item"
              data-active={index === active}
              data-group={command.group}
              data-testid={`palette-item-${index}`}
              onMouseEnter={() => setActive(index)}
              onClick={(event) => choose(index, event.metaKey || event.ctrlKey)}
            >
              <span className="palette__label" dir="auto">
                {command.label}
              </span>
              {command.hint && (
                <span className="palette__hint" dir="auto">
                  {command.hint}
                </span>
              )}
              {!asking && <span className="palette__group">{groupLabel(command.group)}</span>}
            </button>
          ))}
          {results.length === 0 && (
            <p className="palette__empty" data-testid="palette-empty">
              {t("palette.empty")}
            </p>
          )}
        </div>
        <footer className="palette__foot">
          <span>
            <CornerDownLeft size={12} aria-hidden="true" /> {t("palette.run")}
          </span>
          <span>{t("palette.loadB")}</span>
        </footer>
      </div>
    </div>
  );
}
