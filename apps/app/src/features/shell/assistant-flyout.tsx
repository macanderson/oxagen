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
//
// A turn in flight is invalidated by the occasion it was asked on, not by the
// place. "org/ws" names a place: A → B → A puts the same string back, so a
// comparison on it cannot tell "still the turn I started" from "back where I
// started", and a slow A turn would land in the transcript the return to A had
// just cleared. The reset bumps a generation instead — a return included — and
// a turn compares the generation it was asked on, so its reply, its run and
// its conversation id reach only the transcript that asked for them.
//
// Each answer names the run it was recorded as, and names it as text, not as a
// link. `list_runs` excludes the `chat` and `api-chat` surfaces — the
// assistant is Oxagen's, and its turns are recorded but never listed as the
// customer's own runs (`packages/handlers/src/run.list.ts`) — so a link here
// would be the only claimed way to the evidence, and there is nothing at the
// other end of it yet: `app/[org]/[ws]/runs/[run]/page.tsx` renders a title
// and reads nothing until WL-35 builds the Run page, and `get_run` declares
// `layers: [schema, api, mcp, unit, docs]` with no `app`, so the contract
// itself makes no app promise to bind. A link to a page that shows a title is
// the same dead end with an anchor on it, and this is the one surface where
// the link would be the whole claim rather than a convenience beside a row
// that is already on screen.
//
// The id stays, in mono, because it is true and it is the handle: `get_run` is
// implemented on the API, MCP and CLI surfaces, so an operator can inspect the
// run today with the id this prints. The link belongs in the change that gives
// it somewhere to go.
//
// Closing returns focus where it came from. The host is always mounted and
// goes `inert` when it closes, so focus left on a control inside it would land
// on an unavailable element or fall to the body; every close path — Escape,
// the close button, the launcher toggling it shut — goes through the one
// effect below.
//
// Below `md` it is `w-full` and covers the application, so there it is a modal
// dialog and everything outside it goes `inert` while it is open — a Tab past
// the send button would otherwise walk into invisible top-bar and page
// controls, and once focus is outside the panel its own Escape handler never
// hears the key. Above `md` it sits beside the page, which stays usable,
// because the page is what it is being asked about. The breakpoint is read as
// a store, so crossing it with the panel open takes and gives back the
// application — and takes focus with it. Above `md` focus is allowed to be out
// on the page; a resize that makes the panel modal would otherwise inert the
// very control focus is sitting on, leaving a keyboard user on something they
// can neither see nor escape from.
//
// The same asymmetry runs the other way on the way out. Closing restores focus
// to the launcher the open was captured from, but a launcher can be connected
// and still unfocusable — a resize below `md` hides the sidebar that holds it
// without unmounting it — so the restore checks that focus actually moved
// rather than that the element is still there.
//
// The transcript is the live region. A refusal carries `role="alert"`, which
// interrupts; an answer is an ordinary paragraph, so `role="log"` on the
// container reads it out to a person whose focus is still on the composer. The
// container renders on every pass and only its contents are conditional: a
// polite region inserted in the same commit as its own text is announced
// unreliably.
import { CircleAlert, Send, Sparkles } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { askAssistant, type ParkedCard } from "./assistant-actions";
import { parseShellPath } from "./nav";
import { useShellState } from "./shell-state";
import { useNavigate } from "@/ui/navigation";

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

/**
 * Below `md` the flyout is `w-full` and covers the application, so it is a
 * modal dialog; above it, it is a panel beside the page and the page it is
 * being asked about stays usable. The query is the complement of Tailwind's
 * `md` (48rem), the breakpoint the class list below switches on.
 */
const COVERS_THE_APP = "(max-width: 47.99rem)";

function subscribeToWidth(onChange: () => void): () => void {
  const mql = window.matchMedia(COVERS_THE_APP);
  mql.addEventListener("change", onChange);
  return () => {
    mql.removeEventListener("change", onChange);
  };
}

/**
 * Whether the flyout covers the application. The viewport is an external store
 * — `useSyncExternalStore` is what reads one without a render that is briefly
 * wrong. The server has no viewport, so it renders the panel the wide screen
 * shows and the first client read corrects it.
 */
function useCoversTheApp(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(COVERS_THE_APP).matches,
    () => false,
  );
}

/**
 * Take the application out of the tab order and the accessibility tree while
 * `node` is a modal dialog over it, and give it back.
 *
 * `inert` is the containment: a keyboard user who tabs past the last control
 * in the panel finds nothing outside it to land on, so focus cannot leave —
 * and while focus stays inside, the panel's own Escape handler keeps hearing
 * the key. That is what a native modal dialog gets from the top layer. Walking
 * up from the panel marks each level's siblings, which is the whole document
 * minus the panel's own line of ancestors; a sibling that is already inert
 * belongs to someone else and is left exactly as it was found.
 */
function inertOutside(node: HTMLElement): () => void {
  const marked: HTMLElement[] = [];
  // Up to and including <body>'s own children, and no further: <head> is a
  // sibling of <body> and inerting it would mean nothing.
  for (
    let el: HTMLElement | null = node;
    el !== null && el !== document.body;
    el = el.parentElement
  ) {
    for (const sibling of Array.from(el.parentElement?.children ?? [])) {
      if (sibling === el || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
  }
  return () => {
    for (const el of marked) el.removeAttribute("inert");
  };
}

/**
 * The record on screen for a route that keeps it in the query string rather
 * than in a path segment (`shared/safe-path.ts`: Spend's finding and key drill,
 * Steering's proposal are query values on one route, ARCHITECTURE.md §1.2), in
 * the order the page selects them.
 *
 * An allow-list, not a pass-through. A query string is whatever the address bar
 * says, so the page context carries a value one of these routes asked for or it
 * carries nothing; a tab, a cursor or an offset names a view, not a record, and
 * is not on this table.
 */
const QUERY_RECORD: Readonly<Record<string, readonly string[]>> = {
  spend: ["finding", "drill"],
  steering: ["proposal"],
  // Register an agent keeps the identity it minted on the name step in the
  // query, so the path segment after the route is the step (`wrap`, `run`) and
  // the record on screen is the agent (`shared/safe-path.ts`, `routes.register`).
  // Without this row "why has this agent not enrolled?" sends `entityId: "wrap"`.
  register: ["agent"],
};

/**
 * `entityId`'s cap in `assistantPageContextSchema`. A longer value is not an
 * id; sending it would refuse the whole turn as invalid rather than answer the
 * question without the record.
 */
const ENTITY_ID_MAX = 256;

/** The first of `keys` the address bar selects something with; a key present but empty is a cleared selection, not a record. */
function selectedBy(
  keys: readonly string[],
  query: Pick<URLSearchParams, "get">,
): string | undefined {
  for (const key of keys) {
    const value = query.get(key);
    if (value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * The record the page is showing. A route keeps it in the path segment after
 * the route — a run id, an agent key — or, where §1.2 makes a selection a query
 * value rather than a route of its own, in one of the values `QUERY_RECORD`
 * names for it. A route does one or the other, so there is no precedence to
 * settle: the table decides which half of the URL is read.
 */
function recordOnPage(
  route: string,
  fromPath: string | undefined,
  query: Pick<URLSearchParams, "get">,
): string | null {
  const keys = QUERY_RECORD[route];
  const found = keys === undefined ? fromPath : selectedBy(keys, query);
  // Past the cap `assistantPageContextSchema` puts on `entityId` it is not an
  // id, and asking without the record beats refusing the turn as invalid.
  if (found === undefined || found.length > ENTITY_ID_MAX) return null;
  return found;
}

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
  const query = useSearchParams();
  const { org, ws, rest } = parseShellPath(pathname);
  const panelRef = useRef<HTMLElement>(null);
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
  // Which visit to a workspace the transcript belongs to. Every transition
  // bumps it, a return to a workspace included, which is the whole point: a
  // turn started on the first visit to A must not land on the second.
  const [generation, setGeneration] = useState(0);
  if (scope !== null && scope !== scopeShown) {
    // Adjusting state during render rather than in an effect: the stale
    // transcript never paints under the new workspace.
    setScopeShown(scope);
    setGeneration((n) => n + 1);
    setEntries([]);
    setConversationId(null);
    setDraft("");
    setPending(false);
  }
  // Read by a turn that is still in flight when the person moves: the reply
  // resolves outside the render that started it and must compare against now,
  // not against then.
  //
  // Written here rather than from an effect. React commits the reset above and
  // flushes that render's passive effects a task later, so a reply landing in
  // between would read the generation the person has left, pass the guard, and
  // append one workspace's answer, run and conversation id to another
  // workspace's transcript — the very thing the reset just cleared. The
  // invalidation has to be as synchronous as the reset is.
  //
  // Assigning on every render, not only on the change, is what makes a render
  // write safe: the value is a pure function of this render's own state, so a
  // render React discards leaves nothing behind — the next committed render
  // writes what that render's state says, and a navigation that never commits
  // restores the generation its turn was asked on.
  const generationRef = useRef(generation);
  // react-hooks/refs guards against a ref whose value is *rendered from*, which
  // can leave the screen behind the data. This one is never read during render
  // — only from a turn's continuation, after the awaited action resolves — and
  // the effect the rule steers towards is the defect being fixed here.
  // eslint-disable-next-line react-hooks/refs -- an invalidation token read only outside render; an effect writes it a task too late (see above)
  generationRef.current = generation;

  // Where focus came from, so closing can give it back. Captured at the open,
  // which is the launcher that was tapped — the rail's on a desktop, or, on a
  // phone, whatever the drawer handed focus to as it closed itself.
  const openedFromRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (assistantOpen) {
      const active = document.activeElement;
      openedFromRef.current = active instanceof HTMLElement ? active : null;
      closeRef.current?.focus();
      return;
    }
    const openedFrom = openedFromRef.current;
    openedFromRef.current = null;
    // On a phone this is `document.body`: the drawer had already unmounted the
    // launcher that was tapped by the time the open ran, so there is no control
    // to go back to and focusing the body is the drop, not a restore.
    //
    // `isConnected` is not enough to know the restore worked. A launcher opened
    // on a desktop is still connected after a resize below `md`, but its
    // sidebar ancestor is `hidden` by then, so `focus()` is a no-op and returning
    // here would leave focus on the panel that has just gone `inert`. What the
    // restore promised is that focus *moved*, so that is what is checked.
    if (openedFrom !== null && openedFrom.isConnected) {
      openedFrom.focus();
      if (document.activeElement === openedFrom) return;
    }
    // Nothing took it. Either the control that opened this is gone — the phone
    // case, where the drawer's launcher unmounted with the drawer — or it is
    // present but unfocusable, the resized-desktop case. Take focus off the
    // panel that has just gone `inert` anyway, so the next Tab starts from the
    // top of the document instead of from a control no one can reach. A browser
    // blurs an inert subtree by itself; doing it here is what makes that true in
    // a test too.
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active))
      active.blur();
  }, [assistantOpen]);

  // Modal only where it covers the application. Cleanups run before setups, so
  // a close hands the application back before the effect above gives focus to
  // the launcher it is handing back to.
  const coversTheApp = useCoversTheApp();
  const modal = assistantOpen && coversTheApp;
  useEffect(() => {
    const panel = panelRef.current;
    if (!modal || panel === null) return;
    const release = inertOutside(panel);
    // Becoming modal is not only an open. Above `md` the page behind stays
    // interactive on purpose, so focus can be sitting on a page control when a
    // resize or a rotation crosses below the breakpoint — and `inertOutside`
    // has just made that control inert under it. The open effect does not re-run
    // on a resize, so nothing else would move focus back in, and an Escape from
    // outside the panel never reaches its handler.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !panel.contains(active))
      closeRef.current?.focus();
    return release;
  }, [modal]);

  // Keep the newest turn in view. Guarded because scrollTo is a browser
  // affordance jsdom does not implement, and the shell's own tests mount this
  // host on every render — a cosmetic scroll must not fail them.
  useEffect(() => {
    const log = logRef.current;
    if (log === null || typeof log.scrollTo !== "function") return;
    log.scrollTo({ top: log.scrollHeight });
  }, [entries]);

  const navigate = useNavigate();
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
    const asked = generationRef.current;
    /**
     * This turn still owns the transcript: the person has not left the
     * workspace, nor left it and come back, since it was asked. Either would
     * make its reply, its run and its conversation id belong to a transcript
     * that is no longer this one.
     *
     * One generation holds at most one turn in flight, so nothing else can be
     * racing this one for `conversationId`: a second turn needs a second
     * submit, `onSubmit` refuses one while `pending`, and the only thing that
     * clears `pending` early is the reset — which bumps the generation and
     * discards this turn on its way past. The test named "refuses a second
     * question while a turn is in flight" is what keeps that true.
     */
    const stillOurs = () => generationRef.current === asked;
    try {
      const route = rest[0] ?? "fleet";
      const result = await askAssistant(org, ws, {
        conversationId,
        content,
        route,
        entityId: recordOnPage(route, rest[1], query),
      });
      if (!stillOurs()) return;
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
        // A parked write is a new approval on the record, created after Fleet
        // and the shell's waiting count were server-rendered
        // (`features/fleet/fleet.tsx` reads `approvals.pending` once per
        // render, and there is no poll). The sentence beside this sends the
        // person to Fleet to approve them and they expire, so a stale view has
        // a deadline on it. `navigate.refresh()` re-renders the server
        // components at the URL already showing, without a history entry —
        // only when something actually parked, because an ordinary turn
        // changes nothing either surface reads.
        if (result.value.parkedCards.length > 0) navigate.refresh();
      } else {
        setEntries((prior) => [
          ...prior,
          { kind: "refused", id: `${id}-a`, code: refusalKey(result) },
        ]);
      }
    } catch {
      if (!stillOurs()) return;
      setEntries((prior) => [
        ...prior,
        { kind: "refused", id: `${id}-a`, code: "unavailable" },
      ]);
    } finally {
      if (stillOurs()) setPending(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id={ASSISTANT_PANEL_ID}
      // A dialog at both widths — the role does not change under a resize —
      // and modal only at the width where it covers what it is beside. Closed,
      // it is not a dialog at all: the host stays mounted so a half-typed
      // message survives, and an empty dialog that nothing can reach is not
      // what it is. `inert` already says so; the role says it to anything that
      // reads the markup without honouring `inert`.
      role={assistantOpen ? "dialog" : undefined}
      aria-modal={assistantOpen ? modal : undefined}
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

      {/*
        The conversation, and the live region that announces it. `role="log"`
        is polite and reads what is added, which is what an answer arriving
        while focus is still on the composer needs; a refusal keeps its own
        `role="alert"`, which is assertive and interrupts.

        The region is this container, which renders on every pass, rather than
        the list inside it, which appears with the first turn: a polite region
        inserted in the same commit as the text it holds is announced
        unreliably, so only the contents may be conditional.
      */}
      <div
        ref={logRef}
        role="log"
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
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
                    <p
                      data-testid="assistant-recorded-as"
                      className="mt-1 font-mono text-[11px] text-muted-foreground"
                    >
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
