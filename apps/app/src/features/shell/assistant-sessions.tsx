"use client";
// The flyout's session list (#4435): the viewer's active conversations in the
// workspace, newest activity first, read again each time the list is shown.
// A row opens its session in the thread view, and the next question continues
// it. A session leaves the list when the archive sweep takes it: after 7 idle
// days, or the days the workspace sets in `[stella] archive_after_days`.
//
// The status is a polite live region that renders on every pass, with only
// its text conditional, the rule the flyout's log follows: a region inserted
// in the same commit as its own text is announced unreliably. It has no
// height while it is empty.
//
// A session cannot be opened while a turn is in flight. The turn writes its
// reply to the thread on screen, and swapping the conversation under it would
// file that reply under the wrong one. The current session's row only goes
// back to the thread.
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type {
  AssistantSession,
  AssistantThread,
} from "@/data/contracts/conversations";
import { linkText } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import {
  listAssistantSessions,
  openAssistantSession,
} from "./assistant-thread-actions";

type Listed =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      sessions: readonly AssistantSession[];
      /** When the list was read: each row's last activity is relative to it. */
      readAt: Date;
    };

export function AssistantSessions({
  org,
  ws,
  shown,
  currentId,
  pending,
  onOpened,
  onShowCurrent,
}: {
  org: string;
  ws: string;
  /** Whether the list is on screen: it is read each time it is shown. */
  shown: boolean;
  /** The conversation the thread view continues, or null for a new one. */
  currentId: string | null;
  /** Whether a turn is in flight in the thread on screen. */
  pending: boolean;
  onOpened: (thread: AssistantThread) => void;
  onShowCurrent: () => void;
}) {
  const t = useTranslations("shell.assistant.sessions");
  const format = useFormatter();
  const [listed, setListed] = useState<Listed>({ state: "loading" });
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState<"gone" | "failed" | null>(null);

  // A new read each time the list is shown, set during render so the last
  // read's rows never paint as if they were fresh.
  const [wasShown, setWasShown] = useState(shown);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (shown) {
      setListed({ state: "loading" });
      setOpenFailed(null);
    }
  }

  useEffect(() => {
    if (!shown || listed.state !== "loading") return;
    let current = true;
    listAssistantSessions(org, ws).then(
      (result) => {
        if (!current) return;
        setListed(
          result.ok
            ? { state: "ready", sessions: result.value, readAt: new Date() }
            : { state: "failed" },
        );
      },
      () => {
        if (current) setListed({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [shown, listed.state, org, ws]);

  // A session opened after the list went away (a workspace switch unmounts
  // it) is dropped: the person is no longer looking at this workspace.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function open(session: AssistantSession) {
    if (session.id === currentId) {
      onShowCurrent();
      return;
    }
    if (pending || opening !== null) return;
    setOpening(session.id);
    setOpenFailed(null);
    const result = await openAssistantSession(org, ws, session.id).catch(
      () => null,
    );
    if (!mountedRef.current) return;
    setOpening(null);
    if (result === null) {
      setOpenFailed("failed");
      return;
    }
    if (result.ok) {
      onOpened(result.value);
      return;
    }
    const gone =
      result.reason === "not_found" && result.code === "conversation_not_found";
    setOpenFailed(gone ? "gone" : "failed");
    // A session that is gone is read off the list.
    if (gone) setListed({ state: "loading" });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="flex-none px-4 pt-1 pb-2 text-[12px] font-semibold text-muted-foreground">
        {t("title")}
      </h3>
      <p
        role="status"
        data-testid="assistant-sessions-status"
        className="flex-none px-4 text-[13px] leading-5 text-muted-foreground"
      >
        {listed.state === "loading"
          ? t("loading")
          : listed.state === "failed"
            ? t("failed")
            : listed.sessions.length === 0
              ? t("empty")
              : pending
                ? t("busy")
                : null}
      </p>
      {listed.state === "failed" ? (
        <button
          type="button"
          data-testid="assistant-sessions-retry"
          onClick={() => {
            setListed({ state: "loading" });
          }}
          className={`mx-4 mt-1.5 w-fit flex-none text-[12px] ${linkText}`}
        >
          {t("retry")}
        </button>
      ) : null}
      {openFailed === null ? null : (
        <p
          role="alert"
          data-testid="assistant-sessions-open-failed"
          className="mx-4 mt-1.5 flex-none text-[13px] leading-5 text-error-ink"
        >
          {openFailed === "gone" ? t("gone") : t("openFailed")}
        </p>
      )}
      {listed.state === "ready" && listed.sessions.length > 0 ? (
        <ul
          data-testid="assistant-sessions"
          className="min-h-0 flex-1 overflow-y-auto px-2 py-1"
        >
          {listed.sessions.map((session) => {
            const current = session.id === currentId;
            const updated = new Date(session.updatedAt);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  data-testid="assistant-session"
                  aria-current={current ? "true" : undefined}
                  aria-busy={opening === session.id ? true : undefined}
                  disabled={!current && (pending || opening !== null)}
                  onClick={() => {
                    void open(session);
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 disabled:hover:bg-transparent aria-[current=true]:bg-secondary"
                >
                  <span className="truncate text-[13px] leading-5 text-foreground">
                    {session.title ?? t("untitled")}
                  </span>
                  <span className="flex gap-2 text-[11px] text-muted-foreground">
                    <time
                      dateTime={session.updatedAt}
                      title={format.dateTime(updated, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    >
                      {format.relativeTime(updated, listed.readAt)}
                    </time>
                    {current ? <span>{t("current")}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex-1" />
      )}
      <p className="flex-none border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        {t("archive")}
      </p>
    </div>
  );
}
