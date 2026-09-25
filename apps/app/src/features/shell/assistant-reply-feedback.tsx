"use client";
// Two controls under an answered reply (#4169): useful and wrong. Useful
// records at once. Wrong opens a short note first, which the person may leave
// empty. Either way the vote goes to `record_reply_feedback`, which appends it
// to ClickHouse against the run the reply was recorded as, and the line under
// the controls says it was recorded.
//
// A vote is a row, never an update. The pressed control shows the vote this
// panel recorded, and pressing the other one records a second row, which is
// the one that counts. The panel remembers the vote only while the entry is
// mounted: a workspace round trip remounts the transcript and shows the
// controls unpressed. Voting again then writes one more row, and the newest
// still counts, so nothing is lost by forgetting.
//
// The confirmation is a polite live region that renders on every pass with
// conditional contents, the way the flyout's log does, because a region
// inserted in the same commit as its own text is announced unreliably. A
// failure is an alert, like the flyout's refusals.
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { REPLY_FEEDBACK_NOTE_MAX_CHARS } from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import { inputBase, linkText } from "@/ui/control-styles";
import {
  recordReplyFeedback,
  type ReplyVerdict,
} from "./assistant-feedback-actions";

export type AssistantReplyFeedbackProps = {
  /** The workspace the reply was asked in. */
  org: string;
  ws: string;
  /** The conversation that holds the reply. */
  conversationId: string;
  /** `arun_...`: the run the reply was recorded as. */
  runId: string;
};

const VERDICT_BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[12px] text-muted-foreground transition-colors max-md:min-h-11 max-md:px-3 " +
  "hover:bg-secondary hover:text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "aria-pressed:border-rule aria-pressed:bg-secondary aria-pressed:text-foreground disabled:cursor-not-allowed disabled:opacity-60";

export function AssistantReplyFeedback({
  org,
  ws,
  conversationId,
  runId,
}: AssistantReplyFeedbackProps) {
  const t = useTranslations("shell.assistant.feedback");
  const [recorded, setRecorded] = useState<ReplyVerdict | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const wrongRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const hintId = useId();

  // Set when the note closes, so focus goes back to Wrong. Wrong is disabled
  // while a vote is in flight, and a disabled button cannot take focus, so the
  // effect below waits for the vote to settle before it moves focus.
  const returnFocusRef = useRef(false);

  // Opening the note takes focus into it, so a keyboard user types the reason
  // straight after choosing Wrong. Closing it gives focus back to Wrong.
  useEffect(() => {
    if (noting) {
      noteRef.current?.focus();
      return;
    }
    if (!sending && returnFocusRef.current) {
      returnFocusRef.current = false;
      wrongRef.current?.focus();
    }
  }, [noting, sending]);

  /**
   * Record `verdict`. A vote sent from the note closes the note once it is
   * recorded, and keeps it open with the text intact when it is not, so a
   * failed vote can be sent again as it was.
   */
  async function submit(
    verdict: ReplyVerdict,
    withNote: string | null,
    { fromNote }: { fromNote: boolean },
  ) {
    if (sending) return;
    setSending(true);
    setFailed(false);
    try {
      const result = await recordReplyFeedback(org, ws, {
        conversationId,
        runId,
        verdict,
        note: withNote,
      });
      if (result.ok) {
        setRecorded(verdict);
        if (fromNote) closeNote();
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  /** Close the note and give focus back to the control that opened it. */
  function closeNote() {
    setNoting(false);
    setNote("");
    returnFocusRef.current = true;
  }

  function onNoteSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = note.trim();
    void submit("wrong", trimmed === "" ? null : trimmed, { fromNote: true });
  }

  function onNoteKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape closes the note, not the whole flyout around it.
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeNote();
  }

  return (
    <div className="mt-1.5" data-testid="assistant-feedback">
      <div role="group" aria-label={t("label")} className="flex gap-1.5">
        <button
          type="button"
          aria-pressed={recorded === "useful"}
          disabled={sending}
          data-testid="assistant-feedback-useful"
          onClick={() => {
            if (recorded === "useful") return;
            // Choosing Useful abandons a half-written Wrong. Focus stays on
            // the control the person just pressed.
            setNoting(false);
            setNote("");
            void submit("useful", null, { fromNote: false });
          }}
          className={VERDICT_BUTTON}
        >
          <ThumbsUp aria-hidden="true" className="size-3.5" />
          {t("useful")}
        </button>
        <button
          ref={wrongRef}
          type="button"
          aria-pressed={recorded === "wrong"}
          disabled={sending}
          data-testid="assistant-feedback-wrong"
          onClick={() => {
            setFailed(false);
            setNoting(true);
          }}
          className={VERDICT_BUTTON}
        >
          <ThumbsDown aria-hidden="true" className="size-3.5" />
          {t("wrong")}
        </button>
      </div>

      {noting ? (
        <form
          onSubmit={onNoteSubmit}
          className="mt-2 flex flex-col gap-1.5"
          data-testid="assistant-feedback-note-form"
        >
          <label htmlFor={noteId} className="text-[12px] text-foreground">
            {t("noteLabel")}
          </label>
          <textarea
            ref={noteRef}
            id={noteId}
            rows={2}
            maxLength={REPLY_FEEDBACK_NOTE_MAX_CHARS}
            value={note}
            disabled={sending}
            aria-describedby={hintId}
            placeholder={t("notePlaceholder")}
            data-testid="assistant-feedback-note"
            onChange={(e) => {
              setNote(e.target.value);
            }}
            onKeyDown={onNoteKeyDown}
            className={`${inputBase} resize-none`}
          />
          <p id={hintId} className="text-[11px] text-muted-foreground">
            {t("noteHint", { max: REPLY_FEEDBACK_NOTE_MAX_CHARS })}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={sending}
              data-testid="assistant-feedback-send"
              className={VERDICT_BUTTON}
            >
              {t("send")}
            </button>
            <button
              type="button"
              disabled={sending}
              data-testid="assistant-feedback-cancel"
              onClick={closeNote}
              className={`text-[12px] ${linkText} disabled:opacity-60`}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <p
        role="status"
        data-testid="assistant-feedback-recorded"
        className="mt-1 text-[11px] text-muted-foreground"
      >
        {recorded === "useful" ? t("recordedUseful") : null}
        {recorded === "wrong" ? t("recordedWrong") : null}
      </p>
      {failed ? (
        <p
          role="alert"
          data-testid="assistant-feedback-failed"
          className="mt-1 text-[12px] text-error-ink"
        >
          {t("failed")}
        </p>
      ) : null}
    </div>
  );
}
