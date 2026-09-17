"use client";
// The assistant flyout (baseline `asstToggle`/`asstMount`, #2968). It flies out
// from the sidebar over the page instead of pushing it: an operator opens the
// assistant to ask about what is already on screen, so the screen must not
// move. The host is always mounted, so the transition runs and a half-typed
// message survives a close. Closed, it is `inert`: out of the tab order and the
// accessibility tree.
//
// The flyout WL-06 deleted had a `disabled` textarea and a line reading
// "composer.pending" — it drew engine health and an intro and could not ask
// anything. This one asks, through `ask_assistant`, which records each turn as
// a run of its own.
//
// The agent answers over one workspace's fleet record and knowledge graph, and
// the shell mounts at organization scope, so the composer is offered only
// inside a workspace. On an organization page it says so rather than posting a
// question that the kernel would refuse for want of a scope.
//
// The conversation belongs to the workspace it was opened in: the turn handler
// matches the conversation on `(id, orgId, workspaceId)` and raises
// ConversationNotFoundError otherwise. The chrome lives in the organization
// layout and survives a workspace switch, so the transcript and the
// conversation id are keyed to the workspace here — a switch clears them, and
// a reply that lands after the switch is dropped rather than shown under the
// workspace it does not belong to. Standing on an organization page is not a
// switch: it has no workspace of its own, so the transcript waits.
import { CircleAlert, Send, Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { askAssistant, type ParkedCard } from "./assistant-actions";
import { parseShellPath } from "./nav";
import { useShellState } from "./shell-state";

type Entry =
  | { kind: "asked"; id: string; text: string }
  | {
      kind: "answered";
      id: string;
      text: string;
      runId: string;
      parked: readonly ParkedCard[];
    }
  | { kind: "refused"; id: string; code: Refusal };

/** The refusal reasons a turn can come back with, each said plainly. */
type Refusal = "denied" | "invalid" | "exhausted" | "parked" | "unavailable";

function refusalKey(
  result: Extract<Awaited<ReturnType<typeof askAssistant>>, { ok: false }>,
): Refusal {
  if (result.reason === "denied") return "denied";
  if (result.reason === "invalid") return "invalid";
  if (result.reason === "exhausted") return "exhausted";
  if (result.reason === "pending_approval") return "parked";
  return "unavailable";
}

/**
 * Each refusal's sentence, spelled out rather than interpolated: INV-12's
 * catalog walk reads `t()` keys statically, and a computed key reaches no
 * catalog it can check.
 */
function RefusalText({ code }: { code: Refusal }) {
  const t = useTranslations("shell.assistant.refused");
  switch (code) {
    case "denied":
      return <>{t("denied")}</>;
    case "invalid":
      return <>{t("invalid")}</>;
    case "exhausted":
      return <>{t("exhausted")}</>;
    case "parked":
      return <>{t("parked")}</>;
    case "unavailable":
      return <>{t("unavailable")}</>;
  }
}

export function AssistantFlyout() {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, setAssistantOpen } = useShellState();
  const pathname = usePathname();
  const { org, ws, rest } = parseShellPath(pathname);
  const closeRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // A monotonic key per entry: two turns in the same millisecond would collide
  // on a clock-derived one, and React needs these stable across re-renders.
  const nextIdRef = useRef(0);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The workspace the transcript belongs to, "org/ws". Null on an
  // organization page, which owns no conversation and so changes nothing.
  const scope = org === null || ws === null ? null : `${org}/${ws}`;
  const [scopeShown, setScopeShown] = useState(scope);
  // The latest workspace the flyout has been in, read by a turn that is still
  // in flight when the person moves. A ref, because the reply resolves outside
  // the render that started it and must compare against now, not against then.
  const scopeRef = useRef(scope);
  if (scope !== null && scope !== scopeShown) {
    // Adjusting state during render rather than in an effect: the stale
    // transcript never paints under the new workspace.
    setScopeShown(scope);
    setEntries([]);
    setConversationId(null);
    setDraft("");
    setPending(false);
  }
  useEffect(() => {
    if (scope !== null) scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    if (assistantOpen) closeRef.current?.focus();
  }, [assistantOpen]);

  // Keep the newest turn in view. Guarded because scrollTo is a browser
  // affordance jsdom does not implement, and the shell's own tests mount this
  // host on every render — a cosmetic scroll must not fail them.
  useEffect(() => {
    const log = logRef.current;
    if (log === null || typeof log.scrollTo !== "function") return;
    log.scrollTo({ top: log.scrollHeight });
  }, [entries]);

  const inWorkspace = scope !== null;

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (pending || content === "" || org === null || ws === null) return;
    nextIdRef.current += 1;
    const id = `t${nextIdRef.current.toString()}`;
    setEntries((prior) => [...prior, { kind: "asked", id, text: content }]);
    setDraft("");
    setPending(true);
    const asked = `${org}/${ws}`;
    /** The person is still in the workspace this turn was asked from. */
    const stillThere = () => scopeRef.current === asked;
    try {
      const result = await askAssistant(org, ws, {
        conversationId,
        content,
        route: rest[0] ?? "fleet",
        entityId: rest[1] ?? null,
      });
      if (!stillThere()) return;
      if (result.ok) {
        setConversationId(result.value.conversationId);
        setEntries((prior) => [
          ...prior,
          {
            kind: "answered",
            id: `${id}-a`,
            text: result.value.reply,
            runId: result.value.runId,
            parked: result.value.parkedCards,
          },
        ]);
      } else {
        setEntries((prior) => [
          ...prior,
          { kind: "refused", id: `${id}-a`, code: refusalKey(result) },
        ]);
      }
    } catch {
      if (!stillThere()) return;
      setEntries((prior) => [
        ...prior,
        { kind: "refused", id: `${id}-a`, code: "unavailable" },
      ]);
    } finally {
      if (stillThere()) setPending(false);
    }
  }

  return (
    <aside
      id={ASSISTANT_PANEL_ID}
      aria-labelledby={`${ASSISTANT_PANEL_ID}-title`}
      inert={!assistantOpen}
      data-state={assistantOpen ? "open" : "closed"}
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
        <button
          ref={closeRef}
          type="button"
          aria-label={t("close")}
          onClick={() => {
            setAssistantOpen(false);
          }}
          className="ml-auto rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div
            className="flex flex-col gap-2 py-6"
            data-testid="assistant-intro"
          >
            <h3 className="text-sm font-semibold">{t("intro.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("intro.body")}</p>
          </div>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="assistant-log">
            {entries.map((entry) => (
              <li key={entry.id}>
                {entry.kind === "asked" ? (
                  <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                    {entry.text}
                  </p>
                ) : entry.kind === "answered" ? (
                  <div data-testid="assistant-answer">
                    <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {t("recordedAs", { run: entry.runId })}
                    </p>
                    {entry.parked.length === 0 ? null : (
                      <p
                        data-testid="assistant-parked"
                        className="mt-1.5 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground"
                      >
                        {t("parked", { count: entry.parked.length })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p
                    role="alert"
                    data-testid={`assistant-${entry.code}`}
                    className="flex items-start gap-2 text-sm text-error-ink"
                  >
                    <CircleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 flex-none text-error"
                    />
                    <span>
                      <RefusalText code={entry.code} />
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        {pending ? (
          <p
            data-testid="assistant-thinking"
            className="mt-3 text-[13px] text-muted-foreground"
          >
            {t("thinking")}
          </p>
        ) : null}
      </div>

      <div className="flex-none border-t border-border px-3 py-3">
        {inWorkspace ? (
          <form onSubmit={(e) => void onSubmit(e)}>
            <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <textarea
                rows={2}
                value={draft}
                disabled={pending}
                aria-label={t("composer.label")}
                placeholder={t("composer.placeholder")}
                data-testid="assistant-composer"
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
                className="min-h-10 flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                aria-label={t("composer.send")}
                aria-disabled={pending || draft.trim() === "" || undefined}
                data-testid="assistant-send"
                className="mb-0.5 grid size-8 flex-none place-items-center rounded-md bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
              >
                <Send aria-hidden="true" className="size-4" />
              </button>
            </div>
          </form>
        ) : (
          <p
            data-testid="assistant-needs-workspace"
            className="flex items-start gap-2 text-[13px] text-muted-foreground"
          >
            <Sparkles aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span>{t("needsWorkspace")}</span>
          </p>
        )}
      </div>
    </aside>
  );
}
