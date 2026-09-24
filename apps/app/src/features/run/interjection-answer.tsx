"use client";
// The two pick cards and Send this answer on an interjection (spec
// pages/run-interjection.md, the agent's pane). Picking a card is the
// viewer's own choice and lives in this component. Sending is not wired: no
// capability records an answer to an interjection, so the gold button stays
// disabled after a pick and the line under it says why, rather than accepting
// a click that would do nothing.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonPrimary } from "@/ui/control-styles";

type Path = "link" | "create";

export function InterjectionAnswer({
  ws,
  operator,
}: {
  /** The workspace the Link path would bind the repository to. */
  ws: string;
  /** The name the answer would be sent under. */
  operator: string;
}) {
  const t = useTranslations("run.interjection");
  const [picked, setPicked] = useState<Path | null>(null);
  // Each card's line says what the path would do. That is worked out from the
  // config that would apply, which nothing works out yet (#3941), so the line
  // says so rather than printing the mockup's inheritance list.
  const card = (path: Path, title: string) => (
    <button
      type="button"
      aria-pressed={picked === path}
      data-testid={`interjection-pick-${path}`}
      onClick={() => setPicked(path)}
      className="flex min-h-11 w-full items-start gap-3 rounded-lg border border-border bg-app-panel-bg px-3 py-2.5 text-left text-sm font-semibold text-foreground hover:border-foreground aria-pressed:border-gold aria-pressed:bg-gold/10"
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 rounded border ${picked === path ? "border-gold bg-gold" : "border-border"}`}
      />
      <span className="flex flex-col gap-0.5">
        {title}
        <span
          data-gap="interjection-consequences"
          className="text-xs font-normal text-muted-foreground"
        >
          {t("cardNotRecorded")}
        </span>
      </span>
    </button>
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{t("pickLabel")}</legend>
      {card("link", t("link", { ws }))}
      {card("create", t("create"))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled
          data-testid="interjection-send"
          aria-describedby="interjection-send-hint"
          className={`${buttonPrimary} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {t("send")}
        </button>
        <span
          id="interjection-send-hint"
          className="font-mono text-[11px] text-muted-foreground"
        >
          {picked === null ? t("pickOne") : t("answersAs", { name: operator })}
        </span>
      </div>
      {picked === null ? null : (
        <p
          role="status"
          data-gap="interjection-answer"
          className="text-xs text-muted-foreground"
        >
          {t("cannotSend")}
        </p>
      )}
    </fieldset>
  );
}
