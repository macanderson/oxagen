"use client";
// Suggested questions in the empty flyout, chosen by the page the person is on.
//
// Each question is one stella can answer from the reads it holds: runs, spend,
// approvals, agents, and mandates. None asks for a write or a sandbox, because
// a suggestion that parks for approval or cannot run is a worse start than an
// empty composer.
//
// A click fills the composer through `openAssistantDraft`, the path the command
// menu's two drafts take, and sends nothing. The person reads the question,
// edits it or sends it. Unsent work in the composer is kept and the question is
// placed after it, as for any draft. Focus moves to the composer, where the
// next step is taken.
//
// A question names the record on screen by its label. The thread outlives the
// page (ADR-092), so "Why did run arun_01k9 stop?" still says which run when it
// is read from Fleet an hour later, where "this run" would not. The label is
// the one the page declared (`PageRecord`), and the record's id stands in when
// the page declared none, as the breadcrumb does. A page that needs a record
// and has none shows no suggestions rather than a question with a hole in it.
//
// Fleet, Run, Spend, Mandates, and Agents carry questions. Every other page
// carries none: a question chosen for another page is not a question about
// this one, and the intro above already says what stella reads.
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { openAssistantDraft } from "@/shared/assistant-draft";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { parseShellPath } from "./nav";
import { usePageRecord } from "./page-record";

type SuggestionKey =
  | "fleet.waiting"
  | "fleet.stopped"
  | "fleet.spend"
  | "run.stopped"
  | "run.cost"
  | "run.denied"
  | "spend.drivers"
  | "spend.operators"
  | "spend.budget"
  | "mandate.allows"
  | "mandate.left"
  | "mandate.expires"
  | "agents.cost"
  | "agents.waiting"
  | "agent.runs"
  | "agent.cost"
  | "agent.mandate";

const FLEET: readonly SuggestionKey[] = [
  "fleet.waiting",
  "fleet.stopped",
  "fleet.spend",
];
const RUN: readonly SuggestionKey[] = ["run.stopped", "run.cost", "run.denied"];
const SPEND: readonly SuggestionKey[] = [
  "spend.drivers",
  "spend.operators",
  "spend.budget",
];
const MANDATE: readonly SuggestionKey[] = [
  "mandate.allows",
  "mandate.left",
  "mandate.expires",
];
const AGENTS: readonly SuggestionKey[] = ["agents.cost", "agents.waiting"];
const AGENT: readonly SuggestionKey[] = [
  "agent.runs",
  "agent.cost",
  "agent.mandate",
];

/**
 * The longest label a question carries. It is the cap the turn puts on the
 * record's id (`ENTITY_ID_MAX` in the flyout): past it the turn drops the
 * record, so a question naming it would name a record the turn does not carry.
 */
const LABEL_MAX = 256;

/**
 * The questions for a route, as catalog keys under
 * `shell.assistant.suggestions`. `route` is the first path segment after the
 * workspace, `"fleet"` at the workspace root. `label` names the record on
 * screen, or is null when there is none.
 *
 * A run and a mandate are always one record, so their questions need the
 * label and the route shows none without it. Agents is the list without a
 * record and one agent with one.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function suggestionsFor(
  route: string,
  label: string | null,
): readonly SuggestionKey[] {
  switch (route) {
    case "fleet":
      return FLEET;
    case "runs":
      return label === null ? [] : RUN;
    case "spend":
      return SPEND;
    case "mandates":
      return label === null ? [] : MANDATE;
    case "agents":
      return label === null ? AGENTS : AGENT;
    default:
      return [];
  }
}

/** A label a question can carry: not blank, and within the cap. */
function usable(text: string | null | undefined): text is string {
  return (
    text !== null &&
    text !== undefined &&
    text.trim() !== "" &&
    text.length <= LABEL_MAX
  );
}

/**
 * The label of the record on screen, or null when there is none.
 *
 * The page's declaration outranks the path segment, as it does for the record
 * the turn carries: `{ id: null }` says no particular record, whatever the
 * path holds. The declared label names the record when the page gave one, and
 * the id stands in when it did not.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function recordLabel(
  declared: { id: string | null; label: string | null } | null,
  fromPath: string | undefined,
): string | null {
  const id = declared === null ? fromPath : declared.id;
  if (!usable(id)) return null;
  const named = declared?.label;
  return usable(named) ? named : id;
}

/**
 * The questions for the page on screen, rendered in the empty flyout. Renders
 * nothing outside a workspace, where there is no composer to fill, and on a
 * page with no questions.
 */
export function AssistantSuggestions() {
  const t = useTranslations("shell.assistant.suggestions");
  const titleId = useId();
  const { org, ws, rest } = parseShellPath(usePathname());
  const route = rest[0] ?? "fleet";
  const label = recordLabel(usePageRecord(route), rest[1]);
  const keys = suggestionsFor(route, label);
  if (org === null || ws === null || keys.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p id={titleId} className="text-[12px] font-medium text-muted-foreground">
        {t("title")}
      </p>
      <ul
        aria-labelledby={titleId}
        className="flex flex-col gap-1.5"
        data-testid="assistant-suggestions"
      >
        {keys.map((key) => {
          const question = t(key, { label: label ?? "" });
          return (
            <li key={key}>
              <button
                type="button"
                data-testid="assistant-suggestion"
                onClick={(event) => {
                  openAssistantDraft({ org, ws, content: question });
                  event.currentTarget
                    .closest(`#${ASSISTANT_PANEL_ID}`)
                    ?.querySelector("textarea")
                    ?.focus();
                }}
                className="w-full rounded-lg border border-border px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:border-rule hover:bg-button-default-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11"
              >
                {question}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
