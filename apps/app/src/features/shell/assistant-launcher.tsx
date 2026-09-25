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
// It reads "Ask stella*" on one line, after the stella mark (`StellaIcon`) at
// 28px. "stella*" is set as text in the wordmark face (`.ox-wordmark`), and the
// asterisk takes `.ox-wordmark-accent`, whose `--ember-ink` is the kit's deep
// gold on the light theme and the metal on the dark one, so the launcher
// follows the app's theme switch. The mark and the asterisk are hidden from
// assistive technology: the button's name is "Ask stella", not "Ask stella
// star".
//
// #4090 took the icon out, because the text asterisk repeated it, and set
// "oxagen’s in-app AI agent" on a second line. At 13px the asterisk was too
// small to read as stella's mark, and the second line named a category rather
// than the control, so the icon is back and the second line is gone (#4139).
//
// The phone's More sheet has a second control that opens the assistant. Its
// tile leads with the same mark at the same size and reads its name through
// `AskStella`, so the two never name stella differently.
//
// A reply that lands while the flyout is closed marks the launcher unread
// (`noteAssistantReply` in `shell-state.tsx`). It then shines gold around its
// border until the flyout opens, and says "New reply" to a screen reader, so
// the cue is never colour or motion alone.
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { StellaIcon } from "@/ui/stella-mark";
import { useShellState } from "./shell-state";

export const ASSISTANT_PANEL_ID = "shell-assistant";

/** A name set in the wordmark face, inside a translated line. */
function wordmark(chunks: ReactNode) {
  return <span className="ox-wordmark">{chunks}</span>;
}

/** The gold asterisk after "stella", hidden from assistive technology. */
function accent(chunks: ReactNode) {
  return (
    <span aria-hidden="true" className="ox-wordmark-accent">
      {chunks}
    </span>
  );
}

/**
 * "Ask stella*", with "stella*" in the wordmark face. The launcher and the
 * phone's More tile both read it, so the two controls that open the assistant
 * carry one name.
 */
export function AskStella() {
  const t = useTranslations("shell.assistant");
  return <>{t.rich("launcher", { wordmark, accent })}</>;
}

export function AssistantLauncher({
  onNavigate,
}: {
  /** Called after the tap is handled, so the phone drawer can close itself. */
  onNavigate?: () => void;
} = {}) {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, setAssistantOpen, assistantUnread } = useShellState();
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
      data-unread={assistantUnread ? "" : undefined}
      className={`mb-2 flex w-full items-center gap-2.5 rounded-[10px] border bg-card px-2.5 py-2 text-left text-card-foreground transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring ${
        assistantOpen ? "border-gold" : "border-border"
      } ${assistantUnread ? "ox-launcher-unread" : ""}`}
    >
      <StellaIcon className="size-7 flex-none" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">
          <AskStella />
        </span>
        {assistantUnread ? (
          <span className="sr-only" data-testid="assistant-launcher-unread">
            {t("launcherUnread")}
          </span>
        ) : null}
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
