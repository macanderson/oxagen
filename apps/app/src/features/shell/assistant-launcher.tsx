"use client";
// The launcher at the foot of the sidebar: the point the assistant flies out of.
import { ChevronRight, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Read } from "@/data/not-backed";
import type { AssistantEngine } from "./contracts";
import { engineView } from "./engine";
import { useShellState } from "./shell-state";

export const ASSISTANT_PANEL_ID = "shell-assistant";

export function AssistantLauncher({
  engine,
}: {
  engine: Read<AssistantEngine>;
}) {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, toggleAssistant } = useShellState();
  const view = engineView(engine);
  return (
    <button
      type="button"
      onClick={toggleAssistant}
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
        {/* The status words stay in the label ink; the red is carried by the dot.
            The kit's --error is 4.4:1 on the panel, under the 4.5:1 floor for 11px text. */}
        <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-sidebar-nav-label-fg">
          {view.state === "up" ? null : (
            <span
              aria-hidden="true"
              className="size-1.5 flex-none rounded-full bg-error"
            />
          )}
          <span className="truncate">
            {view.state === "up"
              ? t("ready", { model: view.model })
              : t("engineDown")}
          </span>
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
