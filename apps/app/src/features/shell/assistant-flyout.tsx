"use client";
// The assistant flyout host (baseline: `asstToggle`/`asstMount`). It flies out
// from the sidebar over the page instead of pushing it: an operator opens the
// assistant to ask about what is already on screen, so the screen must not move.
// The host is always mounted, so the transition runs and a half-typed message
// survives a close. Closed, it is `inert`: out of the tab order and the
// accessibility tree.
import { CircleAlert, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useTransition } from "react";
import type { Read } from "@/data/not-backed";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import type { AssistantEngine } from "./contracts";
import { engineView } from "./engine";
import { formatTimestamp } from "./format";
import { useShellState } from "./shell-state";

export function AssistantFlyout({ engine }: { engine: Read<AssistantEngine> }) {
  const t = useTranslations("shell.assistant");
  const locale = useLocale();
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const { assistantOpen, setAssistantOpen } = useShellState();
  const closeRef = useRef<HTMLButtonElement>(null);
  const view = engineView(engine);

  useEffect(() => {
    if (assistantOpen) closeRef.current?.focus();
  }, [assistantOpen]);

  return (
    <aside
      id={ASSISTANT_PANEL_ID}
      aria-labelledby={`${ASSISTANT_PANEL_ID}-title`}
      inert={!assistantOpen}
      data-state={assistantOpen ? "open" : "closed"}
      data-engine={view.state}
      data-testid="assistant-flyout"
      onKeyDown={(e) => {
        if (e.key === "Escape") setAssistantOpen(false);
      }}
      className={`fixed inset-y-0 left-0 z-50 flex w-full flex-col border-r border-border bg-app-panel-bg pb-[env(safe-area-inset-bottom)] text-app-panel-fg shadow-2xl duration-300 ease-[cubic-bezier(.32,.72,0,1)] motion-reduce:translate-x-0 motion-reduce:duration-100 md:left-(--sidebar-width) md:w-[min(430px,calc(100vw-var(--sidebar-width)-56px))] ${
        assistantOpen
          ? // Visible at once, so the close button can take focus on open…
            "visible translate-x-0 opacity-100 transition-[translate,opacity]"
          : // …and hidden only once the fly-back has finished.
            "invisible -translate-x-full opacity-0 transition-[translate,opacity,visibility]"
      }`}
    >
      <div className="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
        <h2
          id={`${ASSISTANT_PANEL_ID}-title`}
          className="text-sm font-semibold"
        >
          {t("label")}
        </h2>
        {view.state === "up" ? (
          <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {t("badge")}
          </span>
        ) : (
          // Red border and dot, label-ink words: --error is 4.4:1 on the panel at 11px.
          <span className="ml-auto inline-flex items-center gap-1.5 rounded border border-error px-1.5 py-0.5 text-[11px] text-foreground">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-error"
            />
            {t("engineDown")}
          </span>
        )}
        <button
          ref={closeRef}
          type="button"
          aria-label={t("close")}
          onClick={() => {
            setAssistantOpen(false);
          }}
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {view.state === "up" ? (
          <div
            className="flex flex-col gap-2 py-6"
            data-testid="assistant-ready"
          >
            <h3 className="text-sm font-semibold">{t("intro.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("intro.body")}</p>
          </div>
        ) : (
          <div
            role="status"
            data-testid="assistant-engine-down"
            className="flex flex-col items-center gap-3 px-2 py-8 text-center"
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-full border border-current text-error"
            >
              <CircleAlert className="size-5" />
            </span>
            <h3 className="text-[15px] font-semibold">{t("down.title")}</h3>
            <p className="text-[13px] text-muted-foreground">
              {view.reason === "engine"
                ? t("down.body", { status: view.httpStatus })
                : t("down.unwired", { code: view.code, status: view.status })}
            </p>
            <button
              type="button"
              disabled={retrying}
              onClick={() => {
                startRetry(() => {
                  router.refresh();
                });
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-3.5 ${retrying ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
              {t("down.retry")}
            </button>
            <p className="font-mono text-[11px] text-muted-foreground">
              {view.reason === "engine" &&
              view.version !== null &&
              view.lastHealthyAt !== null
                ? t("down.meta", {
                    version: view.version,
                    at: formatTimestamp(view.lastHealthyAt, locale),
                  })
                : t("down.metaUnknown")}
            </p>
          </div>
        )}
      </div>

      <div className="flex-none border-t border-border px-3 py-3">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <textarea
            disabled
            rows={2}
            aria-label={t("composer.label")}
            placeholder={
              view.state === "up"
                ? t("composer.placeholder")
                : t("down.composerPlaceholder")
            }
            className="min-h-10 flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("composer.pending")}
        </p>
      </div>
    </aside>
  );
}
