// parse.ts: read an oxagen-workflow file of any version v0.3 reads, check it,
// and resolve it to one shape the run state machine uses.
//
// parseWorkflow takes the parsed TOML, not the text, so this package needs no
// TOML parser at run time. It checks two sets of rules:
//
// 1. The shape schemas/oxagen-workflow.v0.3.json describes, written out by
//    hand. parse.test.ts runs both against the same documents so they agree.
// 2. The rules the steering PR check enforces and a schema cannot
//    (work-graph-spec.md §8.1): a role is unique, `needs` names roles in the
//    file and never the stage itself, `needs` forms no cycle, and `return_to`
//    is upstream of its stage.
//
// The first stage runs at the send, so it has no `needs`, and every other
// stage waits on at least one stage. With no cycle, every stage is then
// reachable from the first, and [accept] (which needs every stage nothing else
// needs) is reachable from every stage. Those two rules need no check of their
// own.
import { CRITERION_TAGS, type CriterionTag } from "@oxagen/done-record";
import {
  ACCEPT_BY,
  type AcceptBy,
  MAX_RETURNS,
  ON_FAIL,
  type OnFail,
  STAGE_KINDS,
  type StageKind,
  WORKFLOW_SCHEMAS,
  type WorkflowSchema,
} from "../types";
import { findCycle, type StageNode, sinksOf, upstreamOf } from "./graph";

/** One stage after the defaults apply. */
export interface ResolvedStage {
  role: string;
  /** The stage's place in the file, from 0. */
  index: number;
  /** build when the file names no kind. */
  kind: StageKind;
  /** The agent's lineage. The agent file names its operator, runtime, and harness. */
  agent: string;
  /** The model route the file pins, or null when each run picks its model. */
  model: string | null;
  owns: CriterionTag[];
  /** The roles this stage waits on. Without `needs`, the stage before it. */
  needs: string[];
  onFail: OnFail;
  /** The role a return sends work back to. Null when on_fail is stop. */
  returnTo: string | null;
  /** The most returns this stage may send. 0 when on_fail is stop. */
  maxReturns: number;
}

/** A workflow file after the defaults apply. */
export interface ResolvedWorkflow {
  /** The file name without .toml. Work orders and triage name a workflow by it. */
  slug: string;
  schema: WorkflowSchema;
  name: string;
  /** The operator who owns the workflow. Null before v0.3. */
  owner: string | null;
  match: { labels: string[]; collectors: string[] };
  /** Criteria every done record drafted for this workflow starts with. */
  doneCriteria: string[];
  stages: ResolvedStage[];
  /** Who accepts, and the roles that hand off before anyone can. */
  accept: { by: AcceptBy; needs: string[] };
}

/** Why a workflow file does not read. */
export const WORKFLOW_PROBLEM_CODES = [
  "not_a_table",
  "unknown_key",
  "missing_key",
  "bad_value",
  "not_in_version",
  "return_keys",
  "duplicate_role",
  "unknown_need",
  "self_need",
  "first_stage_needs",
  "cycle",
  "unknown_return",
  "return_not_upstream",
] as const;
export type WorkflowProblemCode = (typeof WORKFLOW_PROBLEM_CODES)[number];

/** One problem, at a path such as `stage[1].return_to`. */
export interface WorkflowProblem {
  code: WorkflowProblemCode;
  path: string;
  message: string;
}

export type ParseWorkflowResult =
  | { ok: true; workflow: ResolvedWorkflow }
  | { ok: false; problems: WorkflowProblem[] };

const ACTOR = /^[a-z0-9][a-z0-9._-]*$/;
const LINEAGE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TOP_KEYS = new Set(["schema", "name", "owner", "match", "done", "stage", "accept"]);
const STAGE_KEYS = new Set([
  "role",
  "kind",
  "agent",
  "model",
  "owns",
  "needs",
  "on_fail",
  "return_to",
  "max_returns",
]);

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isActor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ACTOR.test(value);
}

function isLineage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && LINEAGE.test(value);
}

/** True for a lowercase slug such as `fix-test-verify-review`. */
export function isWorkflowSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SLUG.test(value);
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isCriterionTag(value: unknown): value is CriterionTag {
  return isOneOf(CRITERION_TAGS, value);
}

function isWhole(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Collects problems while the parser walks the file. */
class Problems {
  readonly list: WorkflowProblem[] = [];

  add(code: WorkflowProblemCode, path: string, message: string): void {
    this.list.push({ code, path, message });
  }

  unknownKeys(table: Table, allowed: ReadonlySet<string>, path: string): void {
    for (const key of Object.keys(table)) {
      if (!allowed.has(key)) {
        this.add("unknown_key", join(path, key), `${join(path, key)} is not a key this schema reads.`);
      }
    }
  }

  missing(path: string): void {
    this.add("missing_key", path, `${path} is required.`);
  }

  bad(path: string, expected: string): void {
    this.add("bad_value", path, `${path} must be ${expected}.`);
  }

  /** A key, or a value, that a later schema version added. */
  notInVersion(path: string, schema: WorkflowSchema, since: WorkflowSchema, what = path): void {
    this.add("not_in_version", path, `${what} is not in ${schema}. It arrived in ${since}.`);
  }
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * A list of strings, each passing `check`, with no repeats. Returns null and
 * records a problem when the value is not one.
 */
function readList<T extends string>(
  problems: Problems,
  value: unknown,
  path: string,
  check: (item: unknown) => item is T,
  expected: string,
  minItems = 0,
): T[] | null {
  if (!Array.isArray(value)) {
    problems.bad(path, `a list of ${expected}`);
    return null;
  }
  const items: unknown[] = value;
  if (items.length < minItems) {
    problems.bad(path, `a list of at least ${minItems} ${expected}`);
    return null;
  }
  const out: T[] = [];
  for (const [i, item] of items.entries()) {
    if (!check(item)) {
      problems.bad(`${path}[${i}]`, expected);
      return null;
    }
    if (out.includes(item)) {
      problems.bad(path, `a list with no repeats. ${item} appears twice`);
      return null;
    }
    out.push(item);
  }
  return out;
}

interface RawStage {
  role: string;
  kind: StageKind;
  agent: string;
  model: string | null;
  owns: CriterionTag[];
  needs: string[] | null;
  onFail: OnFail;
  returnTo: string | number | null;
  maxReturns: number;
}

function readStage(problems: Problems, value: unknown, index: number, schema: WorkflowSchema): RawStage | null {
  const path = `stage[${index}]`;
  if (!isTable(value)) {
    problems.add("not_a_table", path, `${path} must be a [[stage]] table.`);
    return null;
  }
  const before = problems.list.length;
  problems.unknownKeys(value, STAGE_KEYS, path);
  const isV3 = schema === "oxagen-workflow/v0.3";
  const isV1 = schema === "oxagen-workflow/v0.1";

  const role = value.role;
  if (role === undefined) problems.missing(`${path}.role`);
  else if (!isText(role)) problems.bad(`${path}.role`, "a non-empty string");

  const agent = value.agent;
  if (agent === undefined) problems.missing(`${path}.agent`);
  else if (!isLineage(agent)) problems.bad(`${path}.agent`, "an agent lineage such as aintel.core.bug-fixer");

  let kind: StageKind = "build";
  if (value.kind !== undefined) {
    if (!isV3) problems.notInVersion(`${path}.kind`, schema, "oxagen-workflow/v0.3");
    else if (isOneOf(STAGE_KINDS, value.kind)) kind = value.kind;
    else problems.bad(`${path}.kind`, `one of ${STAGE_KINDS.join(", ")}`);
  }

  let model: string | null = null;
  if (value.model !== undefined) {
    if (!isV3) problems.notInVersion(`${path}.model`, schema, "oxagen-workflow/v0.3");
    else if (isText(value.model)) model = value.model;
    else problems.bad(`${path}.model`, "a model route");
  }

  let owns: CriterionTag[] = [];
  if (value.owns !== undefined) {
    owns =
      readList(problems, value.owns, `${path}.owns`, isCriterionTag, `criterion tags (${CRITERION_TAGS.join(", ")})`) ??
      [];
  }

  let needs: string[] | null = null;
  if (value.needs !== undefined) {
    if (isV1) problems.notInVersion(`${path}.needs`, schema, "oxagen-workflow/v0.2");
    else needs = readList(problems, value.needs, `${path}.needs`, isText, "roles", 1);
  }

  let onFail: OnFail = "stop";
  if (value.on_fail !== undefined) {
    if (isOneOf(ON_FAIL, value.on_fail)) onFail = value.on_fail;
    else problems.bad(`${path}.on_fail`, `one of ${ON_FAIL.join(", ")}`);
  }

  let returnTo: string | number | null = null;
  let maxReturns = 0;
  if (onFail === "return") {
    if (value.return_to === undefined) problems.missing(`${path}.return_to`);
    else if (isV1) {
      if (isWhole(value.return_to, 1)) returnTo = value.return_to;
      else problems.bad(`${path}.return_to`, "a stage number from 1 in oxagen-workflow/v0.1");
    } else if (isText(value.return_to)) returnTo = value.return_to;
    else problems.bad(`${path}.return_to`, "a role");

    if (value.max_returns === undefined) problems.missing(`${path}.max_returns`);
    else if (isWhole(value.max_returns, 1, MAX_RETURNS)) maxReturns = value.max_returns;
    else problems.bad(`${path}.max_returns`, `a whole number from 1 to ${MAX_RETURNS}`);
  } else {
    for (const key of ["return_to", "max_returns"]) {
      if (value[key] !== undefined) {
        problems.add("return_keys", `${path}.${key}`, `${path}.${key} applies only when on_fail is return.`);
      }
    }
  }

  if (problems.list.length > before) return null;
  return {
    role: role as string,
    kind,
    agent: agent as string,
    model,
    owns,
    needs,
    onFail,
    returnTo,
    maxReturns,
  };
}

/** Read the [match] table. v0.3 only. */
function readMatch(problems: Problems, value: unknown): ResolvedWorkflow["match"] {
  const match = { labels: [] as string[], collectors: [] as string[] };
  if (!isTable(value)) {
    problems.add("not_a_table", "match", "match must be a [match] table.");
    return match;
  }
  problems.unknownKeys(value, new Set(["labels", "collectors"]), "match");
  if (value.labels !== undefined) {
    match.labels = readList(problems, value.labels, "match.labels", isText, "labels") ?? [];
  }
  if (value.collectors !== undefined) {
    match.collectors = readList(problems, value.collectors, "match.collectors", isWorkflowSlug, "collector names") ?? [];
  }
  return match;
}

/** Read the [done] table. v0.3 only. */
function readDone(problems: Problems, value: unknown): string[] {
  if (!isTable(value)) {
    problems.add("not_a_table", "done", "done must be a [done] table.");
    return [];
  }
  problems.unknownKeys(value, new Set(["criteria"]), "done");
  if (value.criteria === undefined) {
    problems.missing("done.criteria");
    return [];
  }
  return readList(problems, value.criteria, "done.criteria", isText, "criteria", 1) ?? [];
}

/** Read the [accept] table. A file without one accepts by operator. */
function readAccept(problems: Problems, value: unknown, schema: WorkflowSchema): AcceptBy {
  if (value === undefined) return "operator";
  if (!isTable(value)) {
    problems.add("not_a_table", "accept", "accept must be an [accept] table.");
    return "operator";
  }
  problems.unknownKeys(value, new Set(["by"]), "accept");
  if (value.by === undefined) {
    problems.missing("accept.by");
    return "operator";
  }
  if (!isOneOf(ACCEPT_BY, value.by)) {
    problems.bad("accept.by", `one of ${ACCEPT_BY.join(", ")}`);
    return "operator";
  }
  if (value.by === "proven" && schema !== "oxagen-workflow/v0.3") {
    problems.notInVersion("accept.by", schema, "oxagen-workflow/v0.3", 'by = "proven"');
  }
  return value.by;
}

/** Check the rules a schema cannot, and resolve each stage's needs and return. */
function resolveStages(problems: Problems, raw: RawStage[]): ResolvedStage[] {
  const roles = raw.map((stage) => stage.role);
  const seen = new Set<string>();
  for (const [i, role] of roles.entries()) {
    if (seen.has(role)) problems.add("duplicate_role", `stage[${i}].role`, `Role ${role} appears more than once.`);
    seen.add(role);
  }

  const nodes = raw.map((stage, i) => ({
    role: stage.role,
    needs: stage.needs ?? (i === 0 ? [] : [roles[i - 1] as string]),
  }));

  for (const [i, stage] of raw.entries()) {
    if (i === 0 && stage.needs !== null) {
      problems.add("first_stage_needs", "stage[0].needs", "The first stage runs at the send and has no needs.");
    }
    for (const need of stage.needs ?? []) {
      if (need === stage.role) {
        problems.add("self_need", `stage[${i}].needs`, `Stage ${stage.role} cannot need itself.`);
      } else if (!seen.has(need)) {
        problems.add("unknown_need", `stage[${i}].needs`, `Stage ${stage.role} needs ${need}, which is not a role in this file.`);
      }
    }
  }

  const cycle = findCycle(nodes);
  if (cycle) {
    problems.add("cycle", "stage", `needs forms a cycle: ${[...cycle, cycle[0]].join(" needs ")}.`);
  }

  const resolved: ResolvedStage[] = [];
  for (const [i, stage] of raw.entries()) {
    let returnTo: string | null = null;
    if (typeof stage.returnTo === "number") {
      returnTo = roles[stage.returnTo - 1] ?? null;
      if (returnTo === null) {
        problems.add(
          "unknown_return",
          `stage[${i}].return_to`,
          `Stage ${stage.role} returns to stage ${stage.returnTo}, and the file has ${roles.length}.`,
        );
      }
    } else if (stage.returnTo !== null) {
      returnTo = stage.returnTo;
      if (!seen.has(returnTo)) {
        problems.add(
          "unknown_return",
          `stage[${i}].return_to`,
          `Stage ${stage.role} returns to ${returnTo}, which is not a role in this file.`,
        );
        returnTo = null;
      }
    }
    if (returnTo !== null && !cycle && !upstreamOf(nodes, stage.role).has(returnTo)) {
      problems.add(
        "return_not_upstream",
        `stage[${i}].return_to`,
        `Stage ${stage.role} returns to ${returnTo}, which does not hand off before it.`,
      );
    }
    resolved.push({
      role: stage.role,
      index: i,
      kind: stage.kind,
      agent: stage.agent,
      model: stage.model,
      owns: stage.owns,
      needs: [...(nodes[i] as StageNode).needs],
      onFail: stage.onFail,
      returnTo,
      maxReturns: stage.maxReturns,
    });
  }
  return resolved;
}

/**
 * Read a parsed oxagen-workflow file. `slug` is the file name without .toml.
 * Returns every problem found, or the workflow with its defaults applied.
 */
export function parseWorkflow(doc: unknown, slug: string): ParseWorkflowResult {
  const problems = new Problems();
  if (!isWorkflowSlug(slug)) {
    problems.bad("(file name)", "a slug such as fix-test-verify-review.toml");
  }
  if (!isTable(doc)) {
    problems.add("not_a_table", "", "A workflow file must be a TOML table.");
    return { ok: false, problems: problems.list };
  }
  problems.unknownKeys(doc, TOP_KEYS, "");

  if (doc.schema === undefined) {
    problems.missing("schema");
    return { ok: false, problems: problems.list };
  }
  if (!isOneOf(WORKFLOW_SCHEMAS, doc.schema)) {
    problems.bad("schema", `one of ${WORKFLOW_SCHEMAS.join(", ")}`);
    return { ok: false, problems: problems.list };
  }
  const schema = doc.schema;
  const isV3 = schema === "oxagen-workflow/v0.3";

  if (doc.name === undefined) problems.missing("name");
  else if (!isText(doc.name)) problems.bad("name", "a non-empty string");

  let owner: string | null = null;
  if (doc.owner === undefined) {
    if (isV3) problems.missing("owner");
  } else if (!isV3) problems.notInVersion("owner", schema, "oxagen-workflow/v0.3");
  else if (isActor(doc.owner)) owner = doc.owner;
  else problems.bad("owner", "a person's handle such as priya");

  let match: ResolvedWorkflow["match"] = { labels: [], collectors: [] };
  if (doc.match !== undefined) {
    if (isV3) match = readMatch(problems, doc.match);
    else problems.notInVersion("match", schema, "oxagen-workflow/v0.3");
  }

  let doneCriteria: string[] = [];
  if (doc.done !== undefined) {
    if (isV3) doneCriteria = readDone(problems, doc.done);
    else problems.notInVersion("done", schema, "oxagen-workflow/v0.3");
  }

  const acceptBy = readAccept(problems, doc.accept, schema);

  const raw: RawStage[] = [];
  if (doc.stage === undefined) problems.missing("stage");
  else if (!Array.isArray(doc.stage) || doc.stage.length === 0) problems.bad("stage", "a list of at least one [[stage]]");
  else {
    const stages: unknown[] = doc.stage;
    for (const [i, value] of stages.entries()) {
      const stage = readStage(problems, value, i, schema);
      if (stage) raw.push(stage);
    }
  }

  // The graph rules need every stage read. Report shape problems first.
  if (problems.list.length > 0) return { ok: false, problems: problems.list };

  const stages = resolveStages(problems, raw);
  if (problems.list.length > 0) return { ok: false, problems: problems.list };

  return {
    ok: true,
    workflow: {
      slug,
      schema,
      name: doc.name as string,
      owner,
      match,
      doneCriteria,
      stages,
      accept: { by: acceptBy, needs: sinksOf(stages) },
    },
  };
}
