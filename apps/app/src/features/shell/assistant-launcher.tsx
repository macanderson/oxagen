"use client";
// The launcher at the foot of the sidebar: the point the assistant flies out of.
// It is rendered twice — once in the desktop rail, once at the foot of the
// phone drawer — because the rail is `hidden md:flex` and the drawer is the
// phone's only path to the sidebar's foot. Without the second one a phone had
// no control that could set `assistantOpen` at all, so `ask_assistant` was
// unreachable below `md` (ADR-026 mobile parity). The drawer passes
// `onNavigate` to close itself, the way it does for every sidebar link: the
// flyout and the drawer share a stacking level, so a drawer left open would
// cover the panel the tap just opened.
//
// The mock labels it "Assistant" with the model and the engine's state under
// it ("z-ai/glm-flash-latest · ready"). No contract returns the assistant's
// model, and `get_assistant_engine` probes the engine up to three times with a
// two-second timeout each, too slow for a read every page render waits on. So
// the line under the label says the two are not read here (#2968, which adds
// the `shell.assistantEngine` port), and a turn that cannot reach the engine
// says so in the flyout, where the person is looking when it matters.
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { StellaIcon } from "@/ui/stella-mark";
import { useShellState } from "./shell-state";

export const ASSISTANT_PANEL_ID = "shell-assistant";

/** The issue that owns the launcher's missing model and engine state, as a data attribute only. */
const ENGINE_GAP = "#2968";

export function AssistantLauncher({
  onNavigate,
}: {
  /** Called after the tap is handled, so the phone drawer can close itself. */
  onNavigate?: () => void;
} = {}) {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, setAssistantOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAssistantOpen(!assistantOpen);
        onNavigate?.();
      }}
      aria-controls={ASSISTANT_PANEL_ID}
      // What it opens is a dialog — modal where the panel covers the
      // application, a panel beside the page where it does not — so the
      // control says so before it is pressed, the way every other control in
      // the chrome that opens one does.
      aria-haspopup="dialog"
      aria-expanded={assistantOpen}
      data-touch-target=""
      data-testid="assistant-launcher"
      className={`mb-2 flex w-full items-center gap-2.5 rounded-[10px] border bg-card px-2.5 py-2 text-left text-card-foreground transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring ${
        assistantOpen ? "border-gold" : "border-border"
      }`}
    >
      {/* Stella's asterisk is the mark, and gold is the mark's colour. */}
      <span
        aria-hidden="true"
        className="grid size-6 flex-none place-items-center rounded-md border border-border bg-background"
      >
        <StellaIcon className="size-5" data-testid="assistant-launcher-icon" />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[13px] font-semibold">{t("launcher")}</b>
        <span
          data-testid="assistant-launcher-not-backed"
          data-gap={ENGINE_GAP}
          className="block truncate font-mono text-[11px] text-sidebar-nav-label-fg"
        >
          {t("launcherNotBacked")}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className={`size-3.5 flex-none transition-transform motion-reduce:transition-none ${
          assistantOpen
            ? "rotate-180 text-accent-text"
            : "text-sidebar-nav-label-fg"
        }`}
      />
    </button>
  );
}
