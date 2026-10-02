// Promote's draft records (memory-collection spec, Promotion; the mockup's
// steering.js `memDrafts`): one draft per selected row, and what
// promote_memories takes back.
//
// A row speaks for every memory that says the same thing, so its draft cites
// the row's waiting memories. The draft's kind starts at the memory's own,
// and its force at the default for that kind. The force always sits inside
// the forces the kind allows: the rule is `forcesFor` in
// @oxagen/oxagen/steering-repo/record-force, the one promote_memories
// enforces, so a draft can never carry a force the write refuses. A
// constraint names its effect, and no other kind carries one.
//
// The draft sends no repositories. promote_memories then scopes the record
// to its first memory's, and to the workspace when that memory names none.
import type { steeringMemoriesPromote } from "@oxagen/oxagen/contracts/steering.memories.promote";
import {
  clampForce,
  forcesFor,
} from "@oxagen/oxagen/steering-repo/record-force";
import { RECORD_KINDS } from "@oxagen/oxagen/steering-repo/record-kind";
import type {
  RecordForce,
  SteeringRecordKind,
  WorkspaceMemory,
} from "@/data/contracts/steering";

type PromoteDrafts =
  (typeof steeringMemoriesPromote)["input"]["_input"]["drafts"];

/** A kind a memory can be promoted as. A skill is a folder, so it is not one. */
export type PromoteKind = Exclude<SteeringRecordKind, "skill">;

/** The seven kinds, in the order the Kind select offers them. */
export const PROMOTE_KINDS: readonly PromoteKind[] = RECORD_KINDS.filter(
  (kind): kind is PromoteKind => kind !== "skill",
);

/**
 * The most drafts one promote_memories call takes: the contract's
 * PROMOTE_DRAFTS_MAX, copied so the browser bundle loads no contract.
 * drafts.test.ts holds the two equal.
 */
export const PROMOTE_DRAFTS_MAX = 50;

/** The most characters a draft's statement holds. */
export const STATEMENT_MAX = 2000;

export type ConstraintEffect = "require" | "forbid";

export type Draft = {
  /** The waiting memories the record cites. The first one speaks for them. */
  ids: string[];
  /** The agents the memories came from, each once; null for a memory with no known agent. */
  agents: (string | null)[];
  statement: string;
  /** The kind the first memory suggests. */
  suggested: PromoteKind;
  kind: PromoteKind;
  force: RecordForce;
  /** Only on a constraint. */
  effect: ConstraintEffect | null;
  /** The repositories the record will be scoped to: the first memory's. Empty is workspace-wide. */
  repos: string[];
};

/**
 * The kind a memory suggests: its own, or a procedure for a skill, since a
 * skill's memory says how to do something.
 */
function suggestedKind(kind: SteeringRecordKind): PromoteKind {
  return kind === "skill" ? "procedure" : kind;
}

/** The force a kind takes when nobody picks one. */
export function defaultForce(kind: PromoteKind): RecordForce {
  return clampForce(kind, null);
}

/** The forces a kind allows, in the order the Force select offers them. */
export function forceChoices(kind: PromoteKind): readonly RecordForce[] {
  return forcesFor(kind);
}

/** The draft for one row's memories, or null when none of them is waiting. */
export function draftOf(members: readonly WorkspaceMemory[]): Draft | null {
  const waiting = members.filter((memory) => memory.state === "waiting");
  const first = waiting[0];
  if (first === undefined) return null;
  const kind = suggestedKind(first.kind);
  return {
    ids: waiting.map((memory) => memory.id),
    agents: [...new Set(waiting.map((memory) => memory.agent))],
    statement: first.statement,
    suggested: kind,
    kind,
    force: defaultForce(kind),
    effect: kind === "constraint" ? "require" : null,
    repos: first.repos ?? [],
  };
}

/**
 * The draft with a new kind. The force stays where the kind allows it and
 * falls to the kind's default otherwise. A constraint keeps or takes an
 * effect, and every other kind drops it.
 */
export function withKind(draft: Draft, kind: PromoteKind): Draft {
  return {
    ...draft,
    kind,
    force: clampForce(kind, draft.force),
    effect: kind === "constraint" ? (draft.effect ?? "require") : null,
  };
}

/** The drafts as promote_memories takes them, or null while a statement is empty. */
export function promotePayload(
  drafts: readonly Draft[],
): PromoteDrafts | null {
  if (drafts.some((draft) => draft.statement.trim() === "")) return null;
  return drafts.map((draft) => ({
    memory_ids: draft.ids,
    statement: draft.statement.trim(),
    kind: draft.kind,
    force: draft.force,
    ...(draft.kind === "constraint" && draft.effect !== null
      ? { effect: draft.effect }
      : {}),
  }));
}
