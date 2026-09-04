import { type KeyboardEvent, useRef } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

interface SegmentedProps<V extends string> {
  label: string;
  value: V;
  options: readonly SegmentedOption<V>[];
  onChange(value: V): void;
  testId?: string;
  tone?: "default" | "agent";
}

/** Accessible radiogroup with roving tabindex and arrow-key selection. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  tone = "default",
}: SegmentedProps<V>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = ["ArrowRight", "ArrowDown"].includes(event.key)
      ? 1
      : ["ArrowLeft", "ArrowUp"].includes(event.key)
        ? -1
        : event.key === "Home"
          ? -index
          : event.key === "End"
            ? options.length - 1 - index
            : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      className={tone === "agent" ? "segmented segmented--agent" : "segmented"}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="segmented__btn"
            data-value={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
