"use client";
// The launcher at the foot of the sidebar: the point the assistant flies out of.
//
// The launcher WL-06 deleted reported engine health beside its label, read
// through a `shell.assistantEngine` port. `get_assistant_engine` is
// workspace-scoped and the shell mounts at organization scope, so that read has
// nowhere to run from here; a turn that cannot reach the engine says so in the
// flyout instead, where the person is looking when it matters.
import { ChevronRight, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useShellState } from "./shell-state";

export const ASSISTANT_PANEL_ID = "shell-assistant";

export function AssistantLauncher() {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, setAssistantOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAssistantOpen(!assistantOpen);
      }}
      aria-controls={ASSISTANT_PANEL_ID}
      aria-expanded={assistantOpen}
      data-testid="assistant-launcher"
      className={`mb-2 flex w-full items-center gap-2.5 rounded-lg border bg-app-panel-bg px-2.5 py-2 text-left text-app-panel-fg transition-colors hover:border-input focus-visible:outline-2 focus-visible:outline-ring ${
        assistantOpen ? "border-primary" : "border-sidebar-border"
      }`}
    >
      <span
        aria-hidden="true"
        className="grid size-6 flex-none place-items-center rounded-md bg-primary text-primary-foreground"
      >
        <Sparkles className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[13px] font-semibold">{t("launcher")}</b>
        <span className="block truncate font-mono text-[11px] text-sidebar-nav-label-fg">
          {t("launcherHint")}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className={`size-3.5 flex-none transition-transform motion-reduce:transition-none ${
          assistantOpen
            ? "rotate-180 text-primary"
            : "text-sidebar-nav-label-fg"
        }`}
      />
    </button>
  );
}
