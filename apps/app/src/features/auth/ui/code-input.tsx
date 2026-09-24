"use client";
// Six one-character inputs for a six-digit code (mockups `obCodes`). Typing a
// digit moves to the next box, Backspace on an empty box moves back, and a
// pasted or autofilled code fills every box. The code reaches the form as one
// hidden field, so the form reads `code` exactly as it did from one input.
// Remount it (a new `key`) to clear it after a refused code.
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

const LENGTH = 6;
/** The boxes' 1-based positions; each is also its stable key. */
const POSITIONS = [1, 2, 3, 4, 5, 6] as const;

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function CodeInput({
  id,
  name,
  label,
  digitLabel,
  error,
  autoFocus = false,
}: {
  id: string;
  name: string;
  label: string;
  /** The accessible name of box `n` (1-based), e.g. "digit 3". */
  digitLabel: (n: number) => string;
  /** Already-translated error text; renders under the boxes and marks them invalid. */
  error?: string | undefined;
  /** Focus the first box on mount: set after a refused code, so the next one can be typed at once. */
  autoFocus?: boolean;
}) {
  const labelId = useId();
  const errorId = `${id}-error`;
  const [digits, setDigits] = useState<string[]>(() =>
    Array.from({ length: LENGTH }, () => ""),
  );
  const boxesRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) boxesRef.current[0]?.focus();
  }, [autoFocus]);

  function focus(index: number) {
    boxesRef.current[Math.max(0, Math.min(LENGTH - 1, index))]?.focus();
  }

  /** Write `value` from box `from` onward; returns the index after the last digit written. */
  function fill(from: number, value: string): number {
    const incoming = onlyDigits(value).slice(0, LENGTH - from);
    if (incoming.length === 0) return from;
    setDigits((current) => {
      const next = [...current];
      for (let i = 0; i < incoming.length; i++)
        next[from + i] = incoming.charAt(i);
      return next;
    });
    return from + incoming.length;
  }

  function onChange(index: number, value: string) {
    if (value === "") {
      setDigits((current) => current.map((d, i) => (i === index ? "" : d)));
      return;
    }
    // A digit typed over a filled box replaces it; a one-time-code autofill
    // lands every digit in the first box and fills them all.
    const typed =
      value.length === 2 && digits[index] !== "" ? value.slice(-1) : value;
    focus(fill(index, typed));
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && digits[index] === "" && index > 0) {
      event.preventDefault();
      setDigits((current) => current.map((d, i) => (i === index - 1 ? "" : d)));
      focus(index - 1);
    } else if (event.key === "ArrowLeft") {
      focus(index - 1);
    } else if (event.key === "ArrowRight") {
      focus(index + 1);
    }
  }

  function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    focus(fill(index, event.clipboardData.getData("text")));
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p id={labelId} className="text-sm font-medium text-foreground">
        {label}
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={error ? errorId : undefined}
        className="flex gap-[5px] sm:gap-2"
      >
        {POSITIONS.map((position, index) => (
          <input
            key={position}
            ref={(node) => {
              boxesRef.current[index] = node;
            }}
            id={`${id}-${String(position)}`}
            aria-label={digitLabel(position)}
            aria-invalid={error ? true : undefined}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            maxLength={index === 0 ? LENGTH : 1}
            value={digits[index] ?? ""}
            onFocus={(e) => {
              e.target.select();
            }}
            onChange={(e) => {
              onChange(index, e.target.value);
            }}
            onKeyDown={(e) => {
              onKeyDown(index, e);
            }}
            onPaste={(e) => {
              onPaste(index, e);
            }}
            className="h-12 w-[calc((100%-25px)/6)] min-w-0 rounded-md border border-input-border bg-input-bg p-0 text-center font-mono text-lg text-input-fg hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring aria-invalid:border-input-invalid-border sm:h-[54px] sm:w-[46px] sm:text-[21px]"
          />
        ))}
      </div>
      <input type="hidden" name={name} value={digits.join("")} />
      {error ? (
        <p id={errorId} className="text-sm text-error-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
