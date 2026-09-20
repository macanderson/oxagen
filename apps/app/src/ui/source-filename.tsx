"use client";

import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useRef, useState } from "react";
import { inputBase, mono } from "@/ui/control-styles";

/** The whole path opens an identifier edit. The source owns the saved name. */
export function SourceFilename({
  path,
  name,
  onRename,
  disabled = false,
}: {
  path: string;
  name: string;
  onRename: (name: string) => boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("ui.sourceFilename");
  const id = useId();
  const restoreFocusRef = useRef(false);
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  }, []);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const cancelledRef = useRef(false);

  function finish(keyboard = false) {
    if (draft === null || cancelledRef.current) return;
    if (draft !== name && !onRename(draft)) {
      setInvalid(true);
      return;
    }
    restoreFocusRef.current = keyboard;
    setDraft(null);
    setInvalid(false);
  }

  return (
    <div className="min-w-0 flex-1">
      {draft === null ? (
        <button
          ref={(button) => {
            if (button && restoreFocusRef.current) {
              button.focus();
              restoreFocusRef.current = false;
            }
          }}
          type="button"
          disabled={disabled}
          title={t("rename", { path })}
          aria-label={t("rename", { path })}
          className={`${mono} group inline-flex max-w-full cursor-text items-center gap-2 rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed`}
          onClick={() => {
            cancelledRef.current = false;
            setInvalid(false);
            setDraft(name);
          }}
        >
          <span className="min-w-0 break-all">{path}</span>
          <Pencil
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground"
          />
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            ref={focusInput}
            aria-label={t("name")}
            aria-invalid={invalid}
            aria-describedby={`${id}-hint`}
            value={draft}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={`${inputBase} ${mono} py-1`}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onBlur={() => {
              finish();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelledRef.current = true;
                restoreFocusRef.current = true;
                setDraft(null);
                setInvalid(false);
              }
            }}
          />
          <span
            id={`${id}-hint`}
            role={invalid ? "alert" : undefined}
            className="text-xs text-muted-foreground"
          >
            {invalid ? t("invalid") : t("hint")}
          </span>
        </div>
      )}
    </div>
  );
}
