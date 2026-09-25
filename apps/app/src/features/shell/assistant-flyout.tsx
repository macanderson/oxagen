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
// A conversation belongs to the workspace it was opened in: the turn handler
// matches it on `(id, orgId, workspaceId)` and raises ConversationNotFoundError
// otherwise. The chrome lives in the organization layout and survives a
// workspace switch, so the flyout keeps one thread per workspace (transcript,
// conversation id, draft, and in-flight flag) and shows the thread of the
// workspace the person is standing in. The threads live in
// `assistant-threads.ts`: each is filed under the workspace's id, not its
// slug, so a rename keeps it, and it is read back from the record when the
// flyout opens, so a reload keeps it too (#4163). Standing on an organization page is not
// a switch: it has no workspace of its own, so the last thread stays on screen
// and only the composer is withheld.
//
// A turn the person walks away from is owned to completion, not cancelled
// (ADR-092). Its reply, run, conversation id, and any parked writes are written
// to the thread of the workspace it was asked in, so they are waiting there on
// the way back, and the workspace the person moved to is never handed a reply
// that is not its own. This used to be the other way round: leaving cleared
// the transcript, a generation counter discarded the reply on its return, and
// the counter had to be written during render, under an `eslint-disable`,
// because an effect wrote it a task too late and a reply could land in that
// gap. Routing by the workspace a turn was asked in removes the race instead
// of winning it: there is no timing at which a reply can reach the wrong
// thread.
//
// A reply streams in as the engine writes it (ADR-176), over the API's chat
// stream (`assistant-stream-client.ts`), with each tool call named while it
// runs. The stream is not the turn: a connection that drops mid-reply keeps
// what arrived, the turn runs on and saves its reply with the run (ADR-092),
// and the person can load the finished reply (`get_assistant_reply`) instead
// of asking again.
//
// Stopping a turn on purpose is a different thing from walking away from it,
// and it is not here. It belongs to run controls (#2953), whose job is to
// cancel any run through one mechanism rather than one per surface. An
// assistant turn is recorded as a run, so that mechanism will cover it. It
// does not exist yet: today nothing stops a turn once it is asked.
//
// Each answer names the run it was recorded as, and links it. `list_runs`
// excludes the `chat` and `api-chat` surfaces — the assistant is Oxagen's, and
// its turns are recorded but never listed as the customer's own runs
// (`packages/handlers/src/run.list.ts`) — so this link is the only way to that
// evidence from the app, which is the reason it has to work rather than a
// reason to withhold it.
//
// It was text until WL-35 (#3282). The page it points at rendered a title and
// read nothing, and `get_run` declared no `app` layer, so an anchor would have
// been a dead end with a claim on it. Both have since changed: the Run page
// reads its run, and `get_run` declares `layers: [..., "app"]`. The link is
// the change that gave it somewhere to go.
//
// Outside a workspace the id stays plain text, because `routes.run` needs an
// org and a workspace to point into and the shell mounts at organization
// scope. The id alone is still the handle: `get_run` is implemented on the
// API, MCP and CLI surfaces, so an operator can inspect the run with it.
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
// Above `md` the right edge is a handle. Dragging it, or pressing the arrow
// keys on it, widens the panel for a long answer and narrows it again, never
// below the 430px it was designed at. A cookie remembers the width, so the
// panel reopens where it was left (`assistant-width.ts`). Below `md` the panel
// is the full screen and has no handle. The width is a CSS variable the `md:`
// class reads, not an inline width, so a phone keeps `w-full` whatever the
// cookie says.
//
// A turn that settles while the panel is closed tells the shell
// (`noteAssistantReply`), and the launcher shines until the panel opens again.
//
// The transcript is the live region. A refusal carries `role="alert"`, which
// interrupts; an answer is an ordinary paragraph, so `role="log"` on the
// container reads it out to a person whose focus is still on the composer. The
// container renders on every pass and only its contents are conditional: a
// polite region inserted in the same commit as its own text is announced
// unreliably.
import { CircleAlert, Send } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ASSISTANT_CONTENT_MAX,
  ASSISTANT_DRAFT_EVENT,
  assistantDraftOf,
} from "@/shared/assistant-draft";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { readAssistantReply } from "./assistant-actions";
import {
  ASSISTANT_ENGINE_REASON_ID,
  AssistantEngineNotice,
} from "./assistant-engine-notice";
import { AssistantMarkdown } from "./assistant-markdown";
import { AssistantParkedApprovals } from "./assistant-parked-approvals";
import {
  askAssistantStream,
  type AssistantRefusal,
  type ParkedCard,
} from "./assistant-stream-client";
import {
  AssistantAnswering,
  AssistantDropped,
  type DroppedLoad,
  type StreamedTool,
} from "./assistant-stream-reply";
import { AssistantSuggestions } from "./assistant-suggestions";
import { AssistantThinking } from "./assistant-thinking";
import { AssistantThreadBar } from "./assistant-thread-bar";
import {
  type RestoredEntry,
  type ThreadState,
  useAssistantThreads,
} from "./assistant-threads";
import {
  ASSISTANT_MIN_WIDTH,
  assistantWidthCookieString,
  clampAssistantWidth,
  readAssistantWidth,
  widestAssistant,
  widthForKey,
} from "./assistant-width";
import { composerKeyAction } from "./composer-keys";
import { parseShellPath } from "./nav";
import { labelOnPage } from "./page-label";
import { usePageRecord } from "./page-record";
import { useShellState } from "./shell-state";
import { useEngineHealth } from "./use-engine-health";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { StellaIcon, StellaWordmark } from "@/ui/stella-mark";

type Entry =
  | { kind: "asked"; id: string; text: string }
  /** A reply the engine is still writing, painted as it arrives. */
  | {
      kind: "answering";
      id: string;
      text: string;
      runId: string | null;
      tools: readonly StreamedTool[];
      parked: readonly ParkedCard[];
    }
  | {
      kind: "answered";
      id: string;
      text: string;
      runId: string;
      parked: readonly ParkedCard[];
    }
  /** A reply whose stream dropped. The turn ran on and saves its reply. */
  | {
      kind: "dropped";
      id: string;
      text: string;
      runId: string | null;
      parked: readonly ParkedCard[];
      /** The workspace the question was asked in, which the load reads. */
      org: string;
      ws: string;
      question: string;
      load: DroppedLoad;
    }
  | {
      kind: "refused";
      id: string;
      code: Refusal;
      /** The code the action answered with, shown so an operator can look it up. */
      detail: string | null;
      /** The question that was refused, so "Ask again" can send it unchanged. */
      question: string;
    };

type AnsweringEntry = Extract<Entry, { kind: "answering" }>;
type DroppedEntry = Extract<Entry, { kind: "dropped" }>;

/**
 * One workspace's conversation with the assistant: what was said, the
 * conversation id that continues it, the half-typed next question, and whether
 * a turn is in flight. Kept per workspace so each one survives the person
 * leaving and coming back (ADR-092).
 */
type Thread = ThreadState<Entry>;

/** A turn read back from the record is already an entry the log draws. */
function restoreEntry(entry: RestoredEntry): Entry {
  return entry;
}

const EMPTY_THREAD: Thread = {
  entries: [],
  conversationId: null,
  draft: "",
  pending: false,
};

/**
 * The refusal reasons a turn can come back with, each said plainly (#3227).
 * The engine being down, a run the ledger would not admit, and a turn the
 * engine stopped are told apart from a network failure, and an empty credit
 * balance from a spent monthly cap, because each asks the person to do
 * something different. The two credit-gate refusals link to their way out.
 */
type Refusal =
  | "denied"
  | "invalid"
  | "exhausted"
  | "noCredit"
  | "spendCap"
  | "keyLimit"
  | "parked"
  | "engine"
  | "unrecorded"
  | "aborted"
  | "model"
  | "unavailable";

/** The refusals worth asking again: the service, not the question, failed. */
const RETRYABLE: ReadonlySet<Refusal> = new Set([
  "engine",
  "unrecorded",
  "aborted",
  "model",
  "unavailable",
]);

/**
 * Below `md` the flyout is `w-full` and covers the application, so it is a
 * modal dialog; above it, it is a panel beside the page and the page it is
 * being asked about stays usable. The query is the complement of Tailwind's
 * `md` (48rem), the breakpoint the class list below switches on.
 */
const COVERS_THE_APP = "(max-width: 47.99rem)";

/**
 * How close to the bottom still counts as reading the newest turn. A few
 * pixels of rounding or a trailing margin must not unpin a reader who never
 * scrolled.
 */
const PIN_SLACK_PX = 32;

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

/** The width cookie changes only through this panel, which re-renders as it writes. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

/** A style that sets CSS custom properties, which React's own type does not name. */
type StyleWithVariables = CSSProperties & Record<`--${string}`, string>;

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
 * `entityId`'s cap in `assistantPageContextSchema`. A longer value is not an
 * id; sending it would refuse the whole turn as invalid rather than answer the
 * question without the record.
 */
const ENTITY_ID_MAX = 256;

/**
 * The record the page is showing.
 *
 * A page that keeps its selection in the query string declares it, with
 * `<PageRecord>`, from the parse it already did in order to render. The shell
 * does not re-derive it: a `finding` outside the Findings tab, a `proposal` off
 * the Context PRs tab, and the `agent` on `/register/wrap` are all cases where
 * the URL and the page disagree, and the page is right.
 *
 * A route whose record is the path segment after it (`runs/[run]`,
 * `agents/[agent]`) needs no declaration, because there the URL cannot
 * disagree. `declared` wins where it exists, so a page that declares `null` --
 * "I am showing no particular record" -- is believed over the path.
 */
function recordOnPage(
  declared: { id: string | null } | null,
  fromPath: string | undefined,
): string | null {
  const found = declared === null ? fromPath : declared.id;
  // Past the cap `assistantPageContextSchema` puts on `entityId` it is not an
  // id, and asking without the record beats refusing the turn as invalid.
  if (found === undefined || found === null || found.length > ENTITY_ID_MAX)
    return null;
  return found;
}

type Refused = AssistantRefusal;

function refusalKey(result: Refused): Refusal {
  switch (result.reason) {
    case "denied":
      return "denied";
    case "invalid":
      return "invalid";
    case "pending_approval":
      return "parked";
    case "exhausted":
      if (result.code === "insufficient_credits") return "noCredit";
      if (result.code === "assistant_spend_cap") return "spendCap";
      if (result.code === "assistant_model_key_limit") return "keyLimit";
      return "exhausted";
    case "conflict":
      return result.code === "engine_aborted" ? "aborted" : "unavailable";
    case "not_found":
    case "unavailable":
      if (result.code === "engine_unavailable") return "engine";
      if (result.code === "assistant_run_not_recorded") return "unrecorded";
      if (result.code === "model_call_failed") return "model";
      return "unavailable";
  }
}

/** The code a refusal carries, if it carries one. */
function refusalDetail(result: Refused): string | null {
  return result.reason === "pending_approval" ? null : result.code;
}

/**
 * Each refusal's sentence, spelled out rather than interpolated: INV-12's
 * catalog walk reads `t()` keys statically, and a computed key reaches no
 * catalog it can check.
 */
function RefusalText({ code, org }: { code: Refusal; org: string | null }) {
  const t = useTranslations("shell.assistant.refused");
  switch (code) {
    case "denied":
      return <>{t("denied")}</>;
    case "invalid":
      return <>{t("invalid")}</>;
    case "exhausted":
      return <>{t("exhausted")}</>;
    // The way out is a top-up on Billing, where the usage credit balance and
    // its purchase form live (features/billing/usage-credits.tsx).
    case "noCredit":
      return (
        <>
          {t("noCredit")}
          {org === null ? null : (
            <>
              {" "}
              <SafeLink
                to={routes.billing(org)}
                data-testid="assistant-buy-credits"
                className={linkText}
              >
                {t("noCreditLink")}
              </SafeLink>
            </>
          )}
        </>
      );
    // The cap bounds only what the platform key pays (ADR-053 §3); a turn on
    // the organization's own key is not held to it.
    case "spendCap":
      return (
        <>
          {t("spendCap")}
          {org === null ? null : (
            <>
              {" "}
              <SafeLink
                to={routes.modelFunding(org)}
                data-testid="assistant-model-funding"
                className={linkText}
              >
                {t("spendCapLink")}
              </SafeLink>
            </>
          )}
        </>
      );
    case "keyLimit":
      return <>{t("keyLimit")}</>;
    case "parked":
      return <>{t("parked")}</>;
    case "engine":
      return <>{t("engine")}</>;
    case "unrecorded":
      return <>{t("unrecorded")}</>;
    case "aborted":
      return <>{t("aborted")}</>;
    case "model":
      return <>{t("model")}</>;
    case "unavailable":
      return <>{t("unavailable")}</>;
  }
}

export function AssistantFlyout({
  enterToSubmit = false,
}: {
  /**
   * The person's `enter_to_submit` preference (ADR-075). On, Enter sends and
   * Shift+Enter adds a line. Off, the stored default, Enter adds a line and
   * Cmd+Enter or Ctrl+Enter sends (`composer-keys.ts`).
   */
  enterToSubmit?: boolean;
}) {
  const t = useTranslations("shell.assistant");
  const { assistantOpen, setAssistantOpen, noteAssistantReply } =
    useShellState();
  const pathname = usePathname();
  const { org, ws, rest } = parseShellPath(pathname);
  // The route the person is standing on, and what that page says it is showing.
  // Read here rather than in the submit handler because it is a subscription.
  const route = rest[0] ?? "fleet";
  const declaredRecord = usePageRecord(route);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // A monotonic key per entry: two turns in the same millisecond would collide
  // on a clock-derived one, and React needs these stable across re-renders.
  const nextIdRef = useRef(0);
  // One thread per workspace, keyed by the workspace's id (ADR-092, #4163).
  // A turn is written to the thread of the workspace it was asked in, whatever
  // the person is looking at when it resolves, so a reply cannot land in the
  // wrong conversation at any timing. The routing is structural, not a race
  // the code has to win. `scope` is null on an organization page.
  const { scope, status, threadOf, updateThread, startNewThread } =
    useAssistantThreads<Entry>({
      org,
      ws,
      open: assistantOpen,
      restore: restoreEntry,
    });
  // Whether the reader is at the bottom of the transcript. A streamed reply
  // grows fragment by fragment, and the growth follows the tail only while the
  // reader has not scrolled up to read something else.
  const pinnedRef = useRef(true);

  // The workspace whose thread is on screen. An organization page is not a
  // switch (it has no conversation of its own), so it keeps showing the last
  // workspace's thread and only withholds the composer. Adjusted during render
  // rather than in an effect so the previous thread never paints under the new
  // workspace.
  const [shownScope, setShownScope] = useState(scope);
  if (scope !== null && scope !== shownScope) setShownScope(scope);
  // The slugs of that workspace, which is where its parked writes were
  // recorded, even on an organization page. They are held apart from
  // `shownScope` because a restored thread is filed under the workspace's
  // key rather than its `org/ws` slugs (#4207), so the scope cannot be split
  // back into them.
  const [shownSlugs, setShownSlugs] = useState<{
    org: string;
    ws: string;
  } | null>(org !== null && ws !== null ? { org, ws } : null);
  if (
    org !== null &&
    ws !== null &&
    (shownSlugs?.org !== org || shownSlugs.ws !== ws)
  )
    setShownSlugs({ org, ws });
  const thread: Thread =
    shownScope === null
      ? EMPTY_THREAD
      : (threadOf(shownScope) ?? EMPTY_THREAD);
  const { entries, draft, pending } = thread;
  const threadOrg = shownSlugs?.org;
  const threadWs = shownSlugs?.ws;

  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const request = assistantDraftOf(event);
      if (
        request === null ||
        request.org !== org ||
        request.ws !== ws ||
        scope === null
      )
        return;
      updateThread(scope, (current) => {
        // Keep unsent work and place the requested change after it.
        const combined = current.draft.trim()
          ? `${current.draft}\n\n${request.content}`
          : request.content;
        return combined.length > ASSISTANT_CONTENT_MAX
          ? { ...current, draftTooLong: true }
          : { ...current, draft: combined, draftTooLong: false };
      });
      setAssistantOpen(true);
    };
    window.addEventListener(ASSISTANT_DRAFT_EVENT, receiveDraft);
    return () => {
      window.removeEventListener(ASSISTANT_DRAFT_EVENT, receiveDraft);
    };
  }, [org, ws, scope, setAssistantOpen, updateThread]);

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

  // Keep the newest turn in view. A new entry, such as the question just
  // asked, always scrolls to it. A streamed reply growing in place follows
  // the tail only while the reader is pinned there. Guarded because scrollTo
  // is a browser affordance jsdom does not implement, and the shell's own
  // tests mount this host on every render — a cosmetic scroll must not fail
  // them.
  const entryCountRef = useRef(entries.length);
  useEffect(() => {
    const log = logRef.current;
    const added = entries.length !== entryCountRef.current;
    entryCountRef.current = entries.length;
    if (log === null || typeof log.scrollTo !== "function") return;
    if (!added && !pinnedRef.current) return;
    log.scrollTo({ top: log.scrollHeight });
  }, [entries]);

  // The width the person left the panel at. The cookie is read as a store:
  // the server renders the designed width, and the first client read corrects
  // it while the panel is still closed and out of sight.
  const savedWidth = useSyncExternalStore(
    subscribeToNothing,
    () => readAssistantWidth(document.cookie),
    () => ASSISTANT_MIN_WIDTH,
  );
  const [chosenWidth, setChosenWidth] = useState<number | null>(null);
  const width = chosenWidth ?? savedWidth;
  // The widest the panel can be where it sits, measured when the handle is
  // grabbed or focused. CSS caps the width at the same limit, so a remembered
  // width wider than this screen reads as the limit.
  const [widest, setWidest] = useState<number | null>(null);
  const shownWidth = widest === null ? width : Math.min(width, widest);
  // The pointer that grabbed the edge. Events from any other pointer, such as
  // a second finger on a touchscreen, are ignored until that one lets go.
  const dragRef = useRef<{
    pointerId: number;
    left: number;
    widest: number;
  } | null>(null);

  function measureWidest(): number {
    const left = panelRef.current?.getBoundingClientRect().left ?? 0;
    const next = widestAssistant(left, window.innerWidth);
    setWidest(next);
    return next;
  }

  function keepWidth(next: number) {
    setChosenWidth(next);
    document.cookie = assistantWidthCookieString(
      next,
      document.URL.startsWith("https:"),
    );
  }

  const widthStyle: StyleWithVariables = {
    "--assistant-width": `${String(width)}px`,
  };

  const navigate = useNavigate();
  const inWorkspace = scope !== null;
  // Whether stella's engine can take a turn, read when the panel opens and
  // held against Send while it cannot (#3227, use-engine-health.ts).
  const engine = useEngineHealth(org, ws, assistantOpen);
  const engineDown = engine.down !== null;

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft.trim(), { fromDraft: true });
  }

  /**
   * Ask `content` in the workspace the person is standing in. From the
   * composer the draft is cleared; "Ask again" sends a refused question as it
   * was and leaves whatever the person has typed since alone.
   */
  async function send(content: string, { fromDraft }: { fromDraft: boolean }) {
    if (
      pending ||
      // An engine that reported itself down takes no turn. The draft stays.
      engineDown ||
      content === "" ||
      content.length > ASSISTANT_CONTENT_MAX ||
      org === null ||
      ws === null ||
      scope === null
    )
      return;
    nextIdRef.current += 1;
    const id = `t${nextIdRef.current.toString()}`;
    /**
     * The thread this turn belongs to, fixed now. Everything it produces goes
     * back to this thread: the reply, the run, the conversation id, a refusal,
     * and the end of `pending`. None of it goes to whichever thread is on screen
     * when the action resolves (ADR-092). A person who asks and then moves on
     * finds the answer when they come back, and the workspace they moved to is
     * never handed a reply that is not its own.
     *
     * One thread holds at most one turn in flight, so nothing races this one
     * for `conversationId`. Two layers hold it, and each is enough on its own:
     * the composer is `disabled` while its thread is `pending`, and the check
     * at the top of this function refuses a submit that reaches it anyway.
     * Both survive the person leaving and coming back, because leaving no
     * longer clears `pending`. The two tests named "refuses a second question
     * …" fail only when both layers are gone, which is what "each is enough"
     * means. Turns in two different workspaces are two conversations and run
     * side by side.
     */
    const asked = scope;
    const { conversationId } = thread;
    const answeringId = `${id}-s`;
    updateThread(asked, (t) => ({
      ...t,
      entries: [
        ...t.entries,
        { kind: "asked", id, text: content },
        {
          kind: "answering",
          id: answeringId,
          text: "",
          runId: null,
          tools: [],
          parked: [],
        },
      ],
      ...(fromDraft ? { draft: "", draftTooLong: false } : {}),
      pending: true,
    }));
    /** Change this turn's reply in progress, in the thread it was asked in. */
    const answering = (change: (entry: AnsweringEntry) => Entry) => {
      updateThread(asked, (t) => ({
        ...t,
        entries: t.entries.map((entry) =>
          entry.id === answeringId && entry.kind === "answering"
            ? change(entry)
            : entry,
        ),
      }));
    };
    // Parked writes counted as they stream in, for the refresh a dropped
    // stream still owes: the approval is on the record either way.
    let parkedSeen = 0;
    try {
      const entityId = recordOnPage(declaredRecord, rest[1]);
      const entityLabel = labelOnPage(declaredRecord, entityId);
      const result = await askAssistantStream(
        org,
        ws,
        {
          conversationId,
          content,
          route,
          entityId,
          // Only a page that named its record sends a label.
          ...(entityLabel === null ? {} : { entityLabel }),
        },
        {
          onRun: (runId) => {
            answering((entry) => ({ ...entry, runId }));
          },
          onText: (delta) => {
            answering((entry) => ({ ...entry, text: entry.text + delta }));
          },
          onToolStart: (call) => {
            const running: StreamedTool = { ...call, status: "running" };
            answering((entry) => ({
              ...entry,
              tools: [...entry.tools, running],
            }));
          },
          onToolEnd: (call) => {
            answering((entry) => ({
              ...entry,
              tools: entry.tools.map((tool) =>
                tool.id === call.id ? { ...tool, status: call.status } : tool,
              ),
            }));
          },
          onParked: (card) => {
            parkedSeen += 1;
            answering((entry) => ({
              ...entry,
              parked: [...entry.parked, card],
            }));
          },
        },
      );
      if (result.ok) {
        const { value } = result;
        // A new entry rather than the one in progress changed in place, so
        // the log announces the finished reply whole, once.
        answering(() => ({
          kind: "answered",
          id: `${id}-a`,
          text: value.reply,
          runId: value.runId,
          parked: value.parkedCards,
        }));
        updateThread(asked, (t) => ({
          ...t,
          conversationId: value.conversationId,
        }));
        // A parked write is a new approval on the record, created after Fleet
        // and the shell's waiting count were server-rendered
        // (`features/fleet/fleet.tsx` reads `approvals.pending` once per
        // render, and there is no poll). The person can decide each one here
        // or on Fleet, and they expire, so a stale Fleet view has a deadline
        // on it. `navigate.refresh()` re-renders the server
        // components at the URL already showing, without a history entry —
        // only when something actually parked, because an ordinary turn
        // changes nothing either surface reads.
        //
        // It refreshes even when the person has moved to another workspace.
        // The shell's waiting count spans the organization, so it is stale
        // wherever they are standing, and the parked notice itself waits in
        // this turn's thread for when they come back.
        if (value.parkedCards.length > 0) navigate.refresh();
      } else if (result.reason === "dropped") {
        // The stream ended early and the turn did not (ADR-092). What arrived
        // stays, and the finished reply can be loaded from the run.
        answering((entry) => ({
          kind: "dropped",
          id: `${id}-d`,
          text: entry.text,
          runId: result.runId ?? entry.runId,
          parked: entry.parked,
          org,
          ws,
          question: content,
          load: "idle",
        }));
        if (parkedSeen > 0) navigate.refresh();
      } else {
        // A refusal mid-stream saves nothing as a reply, so what arrived
        // before it is not kept as one.
        answering(() => ({
          kind: "refused",
          id: `${id}-a`,
          code: refusalKey(result),
          detail: refusalDetail(result),
          question: content,
        }));
        // The turn found the engine down, so read it again past the cache:
        // the line above the composer then says so before the next question.
        if (refusalKey(result) === "engine") void engine.check();
      }
    } catch {
      answering(() => ({
        kind: "refused",
        id: `${id}-a`,
        code: "unavailable",
        detail: null,
        question: content,
      }));
    } finally {
      updateThread(asked, (t) => ({ ...t, pending: false }));
      // An answer, a refusal, or an unreachable engine is each something the
      // person has not read yet if the panel was closed while it ran.
      noteAssistantReply();
    }
  }

  /**
   * Load the finished reply of a turn whose stream dropped, from the run it
   * was recorded as, into the thread it was asked in. A reply still being
   * saved, or a turn that ended without one, says so and keeps the entry.
   */
  async function loadReply(key: string, dropped: DroppedEntry) {
    const { runId } = dropped;
    if (runId === null) return;
    const settle = (change: (entry: DroppedEntry) => Entry) => {
      updateThread(key, (t) => ({
        ...t,
        entries: t.entries.map((entry) =>
          entry.id === dropped.id && entry.kind === "dropped"
            ? change(entry)
            : entry,
        ),
      }));
    };
    settle((entry) => ({ ...entry, load: "loading" }));
    try {
      const result = await readAssistantReply(dropped.org, dropped.ws, runId);
      if (!result.ok) {
        settle((entry) => ({ ...entry, load: "unread" }));
        return;
      }
      const found = result.value;
      if (found.state !== "answered") {
        settle((entry) => ({ ...entry, load: found.state }));
        return;
      }
      settle((entry) => ({
        kind: "answered",
        id: `${entry.id}-a`,
        text: found.reply,
        runId,
        parked: entry.parked,
      }));
      // The next question continues the conversation the reply was saved in,
      // unless the thread has started another since the stream dropped.
      updateThread(key, (t) =>
        t.conversationId === null
          ? { ...t, conversationId: found.conversationId }
          : t,
      );
    } catch {
      settle((entry) => ({ ...entry, load: "unread" }));
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
      style={widthStyle}
      onKeyDown={(e) => {
        if (e.key === "Escape") setAssistantOpen(false);
      }}
      className={`fixed inset-y-0 left-0 z-50 flex w-full flex-col border-r border-border bg-app-raised-bg pb-[env(safe-area-inset-bottom)] text-app-raised-fg shadow-2xl duration-300 ease-[cubic-bezier(.32,.72,0,1)] motion-reduce:translate-x-0 motion-reduce:duration-100 md:left-(--sidebar-width) md:w-[min(var(--assistant-width),calc(100vw-var(--sidebar-width)-56px))] ${
        assistantOpen
          ? // Visible at once, so the close button can take focus on open…
            "visible translate-x-0 opacity-100 transition-[translate,opacity]"
          : // …and hidden only once the fly-back has finished.
            "invisible -translate-x-full opacity-0 transition-[translate,opacity,visibility]"
      }`}
    >
      <div className="flex flex-none items-center gap-2.5 border-b border-border px-4 py-3">
        {/*
          The heading is the stella wordmark. Its name comes from the mark's
          title, so the dialog is still labelled "stella" to a screen reader,
          and the letters take the panel's text colour, so the app's own theme
          switch reaches them (`@/ui/stella-mark`).
        */}
        <h2
          id={`${ASSISTANT_PANEL_ID}-title`}
          className="flex items-center text-app-raised-fg"
        >
          <StellaWordmark
            title={t("label")}
            className="h-[18px] w-auto"
            data-testid="assistant-wordmark"
          />
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

      {inWorkspace ? (
        <AssistantThreadBar
          status={status}
          canStartNew={
            !pending && (entries.length > 0 || thread.conversationId !== null)
          }
          onNewThread={startNewThread}
        />
      ) : null}

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
        onScroll={(e) => {
          const log = e.currentTarget;
          pinnedRef.current =
            log.scrollHeight - log.scrollTop - log.clientHeight < PIN_SLACK_PX;
        }}
      >
        {entries.length === 0 ? (
          <div
            className="flex flex-col gap-2 py-6"
            data-testid="assistant-intro"
          >
            <h3 className="text-sm font-semibold">{t("intro.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("intro.body")}</p>
            <AssistantSuggestions />
          </div>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="assistant-log">
            {entries.map((entry) => (
              <li key={entry.id}>
                {entry.kind === "asked" ? (
                  <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                    {entry.text}
                  </p>
                ) : entry.kind === "answering" ? (
                  <AssistantAnswering text={entry.text} tools={entry.tools} />
                ) : entry.kind === "dropped" ? (
                  <AssistantDropped
                    text={entry.text}
                    runId={entry.runId}
                    load={entry.load}
                    org={entry.org}
                    ws={entry.ws}
                    retryDisabled={pending}
                    onLoad={() => {
                      if (shownScope !== null)
                        void loadReply(shownScope, entry);
                    }}
                    onRetry={() => {
                      void send(entry.question, { fromDraft: false });
                    }}
                  />
                ) : entry.kind === "answered" ? (
                  <div data-testid="assistant-answer">
                    <AssistantMarkdown>{entry.text}</AssistantMarkdown>
                    <p
                      data-testid="assistant-recorded-as"
                      className="mt-1 font-mono text-[11px] text-muted-foreground"
                    >
                      {t("recordedAs")}{" "}
                      {org !== null && ws !== null ? (
                        <SafeLink
                          to={routes.run(org, ws, entry.runId)}
                          className={linkText}
                        >
                          {entry.runId}
                        </SafeLink>
                      ) : (
                        entry.runId
                      )}
                    </p>
                    {entry.parked.length === 0 ? null : (
                      <p
                        data-testid="assistant-parked"
                        className="mt-1.5 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground"
                      >
                        {t("parked", { count: entry.parked.length })}
                      </p>
                    )}
                    {/* Each parked write as a card with Approve and Deny (#4162). */}
                    {entry.parked.length === 0 ||
                    threadOrg === undefined ||
                    threadWs === undefined ? null : (
                      <AssistantParkedApprovals
                        org={threadOrg}
                        ws={threadWs}
                        runId={entry.runId}
                        cards={entry.parked}
                      />
                    )}
                  </div>
                ) : (
                  <div>
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
                        <RefusalText code={entry.code} org={org} />
                      </span>
                    </p>
                    {entry.detail === null ? null : (
                      <p
                        data-testid="assistant-refusal-code"
                        className="mt-1 ml-6 font-mono text-[11px] text-muted-foreground"
                      >
                        {entry.detail}
                      </p>
                    )}
                    {RETRYABLE.has(entry.code) && inWorkspace ? (
                      <button
                        type="button"
                        data-testid="assistant-retry"
                        disabled={pending || engineDown}
                        onClick={() => {
                          void send(entry.question, { fromDraft: false });
                        }}
                        className={`mt-1.5 ml-6 text-[12px] ${linkText} disabled:opacity-60`}
                      >
                        {t("retry")}
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {pending ? <AssistantThinking label={t("thinking")} /> : null}
      </div>

      <div className="flex-none border-t border-border px-3 py-3">
        {inWorkspace ? (
          <form onSubmit={onSubmit}>
            <AssistantEngineNotice
              health={engine}
              onRecovered={() => {
                composerRef.current?.focus();
              }}
            />
            <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <textarea
                ref={composerRef}
                rows={2}
                maxLength={ASSISTANT_CONTENT_MAX}
                value={draft}
                disabled={pending}
                aria-label={t("composer.label")}
                aria-describedby={`${ASSISTANT_PANEL_ID}-send-hint`}
                placeholder={t("composer.placeholder")}
                data-testid="assistant-composer"
                onChange={(e) => {
                  if (shownScope === null) return;
                  const value = e.target.value;
                  updateThread(shownScope, (t) => ({
                    ...t,
                    draft: value,
                    draftTooLong: false,
                  }));
                }}
                onKeyDown={(e) => {
                  if (composerKeyAction(e, enterToSubmit) !== "send") return;
                  // A send adds no line, even when there is nothing to send.
                  // The submit path refuses an empty draft, a turn in flight,
                  // and a draft over the limit, as it does for the Send button.
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }}
                className="min-h-10 flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                aria-label={t("composer.send")}
                aria-disabled={
                  pending || engineDown || draft.trim() === "" || undefined
                }
                aria-describedby={
                  engineDown ? ASSISTANT_ENGINE_REASON_ID : undefined
                }
                data-testid="assistant-send"
                className={`mb-0.5 grid size-8 flex-none place-items-center rounded-md bg-gold text-on-gold focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${
                  engineDown ? "cursor-not-allowed opacity-60" : ""
                }`}
              >
                <Send aria-hidden="true" className="size-4" />
              </button>
            </div>
            {/*
              The send key for the person's setting. The app does not detect
              the platform, so the modifier names both Cmd and Ctrl.
            */}
            <p
              id={`${ASSISTANT_PANEL_ID}-send-hint`}
              data-testid="assistant-send-hint"
              className="mt-1.5 px-1 text-[11px] text-muted-foreground"
            >
              {enterToSubmit
                ? t("composer.sendHintEnter")
                : t("composer.sendHintModEnter")}
            </p>
            {thread.draftTooLong ? (
              <p role="alert" className="mt-2 text-sm text-muted-foreground">
                {t("composer.draftTooLong")}
              </p>
            ) : null}
          </form>
        ) : (
          <p
            data-testid="assistant-needs-workspace"
            className="flex items-start gap-2 text-[13px] text-muted-foreground"
          >
            <StellaIcon className="mt-0.5 size-4 flex-none" />
            <span>{t("needsWorkspace")}</span>
          </p>
        )}
      </div>
      {/*
        The right edge, last in the tab order, after the composer. A pointer
        drag sets the width from where the pointer is, and the width is saved
        when the drag ends. The cursor points only right at the designed
        width, because the edge cannot go further left.
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resize")}
        aria-controls={ASSISTANT_PANEL_ID}
        aria-valuenow={shownWidth}
        aria-valuemin={ASSISTANT_MIN_WIDTH}
        aria-valuemax={widest ?? undefined}
        tabIndex={0}
        data-testid="assistant-resize"
        onFocus={measureWidest}
        onKeyDown={(e) => {
          const next = widthForKey(e.key, shownWidth, measureWidest());
          if (next === null) return;
          e.preventDefault();
          keepWidth(next);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || dragRef.current !== null) return;
          e.preventDefault();
          // Guarded because pointer capture is a browser affordance jsdom
          // does not implement.
          if (typeof e.currentTarget.setPointerCapture === "function")
            e.currentTarget.setPointerCapture(e.pointerId);
          const left = panelRef.current?.getBoundingClientRect().left ?? 0;
          dragRef.current = {
            pointerId: e.pointerId,
            left,
            widest: measureWidest(),
          };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag?.pointerId !== e.pointerId) return;
          setChosenWidth(
            clampAssistantWidth(e.clientX - drag.left, drag.widest),
          );
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          if (drag?.pointerId !== e.pointerId) return;
          dragRef.current = null;
          keepWidth(clampAssistantWidth(e.clientX - drag.left, drag.widest));
        }}
        onPointerCancel={(e) => {
          if (dragRef.current?.pointerId !== e.pointerId) return;
          dragRef.current = null;
          keepWidth(shownWidth);
        }}
        className={`absolute inset-y-0 -right-1 z-10 hidden w-2 touch-none select-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:content-[''] hover:before:bg-rule focus-visible:outline-none focus-visible:before:bg-ring md:block ${
          shownWidth <= ASSISTANT_MIN_WIDTH
            ? "cursor-e-resize"
            : "cursor-ew-resize"
        }`}
      />
    </aside>
  );
}
