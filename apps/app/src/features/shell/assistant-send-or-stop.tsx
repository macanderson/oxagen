"use client";
// The composer's one button (#4164). It is Send, and it becomes Stop while the
// thread's turn is running or its answer is still typing itself out.
//
// Send and Stop are the same <button> element: React keeps a node whose type
// and place do not change, so a person who pressed Send keeps focus on the
// control that now stops the turn, and keeps it when the turn ends and it is
// Send again.
//
// The stop is a POST to the workspace's `assistant/stop` route
// (`assistant-stop.ts`), not a server action. The question is itself a server
// action that stays pending for the whole turn, and one page's actions run one
// at a time, so a stop sent as an action would reach the turn only after it
// had finished.
import { Send, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";

/**
 * Ask the server to stop the turn `turnId` in the workspace it was asked in.
 * True when the server took the stop. The turn then returns with its partial
 * reply marked stopped, or, if it had already finished, with its whole reply.
 * False when the stop did not reach the server or was refused, so the turn is
 * still running.
 */
export async function requestAssistantStop(
  org: string,
  ws: string,
  turnId: string,
): Promise<boolean> {
  try {
    const response = await fetch(routes.assistantStop(org, ws), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const BUTTON =
  "mb-0.5 grid size-8 flex-none place-items-center rounded-md bg-gold text-on-gold focus-visible:outline-2 focus-visible:outline-ring";

export function AssistantSendOrStop({
  stop,
  sendDisabled,
  unavailableReasonId,
}: {
  /**
   * Null shows Send. Otherwise Stop shows, and `stopping` holds it while a
   * stop it sent is on its way, so a second press sends nothing.
   */
  stop: { onStop: () => void; stopping: boolean } | null;
  /**
   * Send is shown but refuses: an empty draft, an engine that is down, or a
   * turn with no Stop. The submit path refuses the same cases.
   */
  sendDisabled: boolean;
  /**
   * The id of the text that says why no question can be sent now, such as
   * the engine notice. Send points at it and looks unavailable. Null when
   * nothing stands in the way.
   */
  unavailableReasonId: string | null;
}) {
  const t = useTranslations("shell.assistant.composer");
  if (stop === null) {
    return (
      <button
        type="submit"
        aria-label={t("send")}
        aria-disabled={sendDisabled || undefined}
        aria-describedby={unavailableReasonId ?? undefined}
        data-testid="assistant-send"
        className={`${BUTTON} disabled:opacity-60 ${
          unavailableReasonId === null ? "" : "cursor-not-allowed opacity-60"
        }`}
      >
        <Send aria-hidden="true" className="size-4" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={t("stop")}
      aria-disabled={stop.stopping || undefined}
      data-testid="assistant-stop"
      onClick={() => {
        if (!stop.stopping) stop.onStop();
      }}
      className={`${BUTTON} aria-disabled:opacity-60`}
    >
      <Square aria-hidden="true" className="size-3.5" fill="currentColor" />
    </button>
  );
}
