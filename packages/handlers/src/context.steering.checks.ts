// context.steering.checks.ts: the checks a steering PR runs, and the six
// checks a PR for one record file under rules/ runs.
//
// A steering PR runs the checks in @oxagen/steering-check. checkSteeringChange()
// reads the PR's head and base trees through a SteeringTreeHost and passes
// them to that package's runChecksWithServers(). It adds no rule of its own.
//
// A PR that Oxagen opens for one record file under rules/ (ADR-061) still runs
// the six §10.3 checks below, the same rules as `stella context validate`:
// schema, lineage uniqueness, record_hash recomputation, a secret and PII
// scan, conflict against active records, and constraint_effect. They read the
// proposal row and one TOML file, which the steering layout does not have, so
// they stay here until that flow moves to the steering layout. Each is a pure
// function of the committed file and what the registry holds, so each has a
// failing fixture in context.steering.checks.test.ts.
import { HandlerError } from "@oxagen/oxagen";
import {
  CHECK_NAMES,
  type CheckName,
  type ConstraintEffect,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { CONTEXT_RECORD_LABEL_MAX } from "@oxagen/oxagen/context-record-label";
import {
  AGENTS_DIR,
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  GITATTRIBUTES_PATH,
  POLICY_DIR,
  README_PATH,
  STEERING_DIR,
  TOOLS_DIR,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  findSecretsAndPii,
  type CheckInput,
  type CheckReport,
  type SteeringTree,
} from "@oxagen/steering-check";
import { runChecksWithServers } from "@oxagen/steering-check/servers";
import type {
  SteeringHost,
  SteeringRepository,
} from "./context.steering.github";
import {
  RECORD_SCHEMA_TAG,
  parseRecordFile,
  RULES_DIR,
  stampRecordObject,
  type RecordFileRecord,
} from "./context.steering.file";

interface CheckOutcome {
  ok: boolean;
  summary: string;
}

interface ActiveRecordRef {
  lineageId: string;
  kind: RecordKind | null;
  constraintEffect: ConstraintEffect | null;
  statement: string | null;
}

export interface CheckContext {
  /** The committed file, as read back from the branch. */
  fileText: string;
  path: string;
  /**
   * Every path the pull request changes at the checked head, against the
   * production branch. The merge squashes all of them, so the record file
   * must be the only one.
   */
  changedPaths: string[];
  proposal: {
    lineageId: string;
    kind: RecordKind;
    force: string;
    constraintEffect: ConstraintEffect | null;
    sharingScope: string;
    statement: string;
    /** The label the proposal sets; null keeps the record's own. */
    label?: string | null;
    rationale: string;
    evidenceLinks: string[];
  };
  /** The registry's record on this lineage, when one is published. */
  published: { path: string | null; version: number | null } | null;
  /** Every active record in the workspace registry, this lineage included. */
  activeRecords: ActiveRecordRef[];
}

const KINDS = new Set([
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);
const FORCES = new Set(["must", "should", "may", "info"]);
const ORIGINS = new Set(["user", "system", "observed", "inferred", "imported"]);
const SHARING = new Set([
  "personal",
  "repository",
  "workspace",
  "organization",
]);
const STATUSES = new Set(["active", "retracted", "archived"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The parsed file, or the reason it is not one; shared by three checks. */
export function parseChecked(fileText: string):
  | {
      ok: true;
      file: {
        set_id: string;
        record: RecordFileRecord[];
        /** Each record as parsed, every member included, for the hash. */
        raw: Record<string, unknown>[];
      };
    }
  | { ok: false; reason: string } {
  let tree: unknown;
  try {
    tree = parseRecordFile(fileText);
  } catch (err) {
    return {
      ok: false,
      reason: `not TOML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isRecord(tree)) return { ok: false, reason: "not a table" };
  if (tree.schema !== RECORD_SCHEMA_TAG) {
    return {
      ok: false,
      reason: `schema is ${JSON.stringify(tree.schema)}, expected ${RECORD_SCHEMA_TAG}`,
    };
  }
  if (typeof tree.set_id !== "string" || tree.set_id.length === 0) {
    return { ok: false, reason: "set_id is missing" };
  }
  if (!Array.isArray(tree.record) || tree.record.length === 0) {
    return { ok: false, reason: "no [[record]]" };
  }
  const records: RecordFileRecord[] = [];
  const raws: Record<string, unknown>[] = [];
  for (const [i, raw] of tree.record.entries()) {
    const at = `record[${i}]`;
    if (!isRecord(raw)) return { ok: false, reason: `${at} is not a table` };
    raws.push(raw);
    const str = (k: string) =>
      typeof raw[k] === "string" && (raw[k] as string).length > 0
        ? (raw[k] as string)
        : null;
    const lineage_id = str("lineage_id");
    if (!lineage_id)
      return { ok: false, reason: `${at}.lineage_id is missing` };
    // Optional: a file written before ADR-178 has none. Present, it is a name
    // a heading can hold.
    const label = raw.label;
    if (
      label !== undefined &&
      (typeof label !== "string" ||
        label.trim().length === 0 ||
        label.length > CONTEXT_RECORD_LABEL_MAX)
    ) {
      return {
        ok: false,
        reason: `${at}.label is 1 to ${CONTEXT_RECORD_LABEL_MAX} characters`,
      };
    }
    const kind = str("kind");
    if (!kind || !KINDS.has(kind)) {
      return {
        ok: false,
        reason: `${at}.kind ${JSON.stringify(raw.kind)} is not one of ${[...KINDS].join(", ")}`,
      };
    }
    const statement = str("statement");
    if (!statement) return { ok: false, reason: `${at}.statement is missing` };
    const origin = str("origin");
    if (!origin || !ORIGINS.has(origin)) {
      return {
        ok: false,
        reason: `${at}.origin ${JSON.stringify(raw.origin)} is not one of ${[...ORIGINS].join(", ")}`,
      };
    }
    const sharing_scope = str("sharing_scope");
    if (!sharing_scope || !SHARING.has(sharing_scope)) {
      return {
        ok: false,
        reason: `${at}.sharing_scope ${JSON.stringify(raw.sharing_scope)} is not one of ${[...SHARING].join(", ")}`,
      };
    }
    const status = str("status");
    if (!status || !STATUSES.has(status)) {
      return {
        ok: false,
        reason: `${at}.status ${JSON.stringify(raw.status)} is not one of ${[...STATUSES].join(", ")}`,
      };
    }
    const record_id = str("record_id");
    const record_hash = str("record_hash");
    if (!record_id || !record_hash) {
      return {
        ok: false,
        reason: `${at} is not stamped (record_id and record_hash)`,
      };
    }
    const provenance = raw.provenance;
    if (
      !isRecord(provenance) ||
      typeof provenance.source_kind !== "string" ||
      typeof provenance.source_uri !== "string"
    ) {
      return {
        ok: false,
        reason: `${at}.provenance needs source_kind and source_uri`,
      };
    }
    const steering = raw.steering;
    if (
      !isRecord(steering) ||
      typeof steering.force !== "string" ||
      !FORCES.has(steering.force)
    ) {
      return {
        ok: false,
        reason: `${at}.steering.force is not one of ${[...FORCES].join(", ")}`,
      };
    }
    records.push({
      lineage_id,
      ...(typeof label === "string" ? { label } : {}),
      record_id,
      record_hash,
      kind,
      statement,
      origin,
      sharing_scope,
      status,
      provenance: {
        source_kind: provenance.source_kind,
        source_uri: provenance.source_uri,
      },
      steering: { force: steering.force },
    });
  }
  return {
    ok: true,
    file: { set_id: tree.set_id, record: records, raw: raws },
  };
}

function checkSchema(ctx: CheckContext): CheckOutcome {
  const others = ctx.changedPaths.filter((p) => p !== ctx.path);
  if (others.length > 0) {
    return {
      ok: false,
      summary: `the pull request also changes ${others.join(", ")}; a Context PR changes ${ctx.path} and nothing else`,
    };
  }
  const parsed = parseChecked(ctx.fileText);
  if (!parsed.ok) return { ok: false, summary: parsed.reason };
  const n = parsed.file.record.length;
  const lineages = new Set(parsed.file.record.map((r) => r.lineage_id)).size;
  return {
    ok: true,
    summary: `${RECORD_SCHEMA_TAG} valid · 1 file, ${n} record${n === 1 ? "" : "s"}, ${lineages} lineage${lineages === 1 ? "" : "s"}`,
  };
}

function checkLineageUniqueness(ctx: CheckContext): CheckOutcome {
  const parsed = parseChecked(ctx.fileText);
  if (!parsed.ok) return { ok: false, summary: parsed.reason };
  if (parsed.file.record.length !== 1) {
    return {
      ok: false,
      summary: `the file holds ${parsed.file.record.length} records; one concern per pull request`,
    };
  }
  const lineage = parsed.file.record[0]!.lineage_id;
  if (lineage !== ctx.proposal.lineageId) {
    return {
      ok: false,
      summary: `the file declares ${lineage}; the proposal is about ${ctx.proposal.lineageId}`,
    };
  }
  // The lineage inside the file is the record's identity, not the file's
  // name (ADR-184). Any `.toml` file under the rules directory can hold it.
  if (!ctx.path.startsWith(`${RULES_DIR}/`) || !ctx.path.endsWith(".toml")) {
    return {
      ok: false,
      summary: `${ctx.path} is not a .toml file under ${RULES_DIR}/, where record files live`,
    };
  }
  const published = ctx.published;
  if (
    published?.path &&
    published.path.startsWith(`${RULES_DIR}/`) &&
    published.path !== ctx.path
  ) {
    return {
      ok: false,
      summary: `${lineage} is already published at ${published.path}; one lineage, one file`,
    };
  }
  if (published) {
    return {
      ok: true,
      summary: `revises the published record on ${lineage} (version ${published.version ?? "?"}) in place`,
    };
  }
  return {
    ok: true,
    summary: `no published record holds ${lineage}; this proposal is its only holder`,
  };
}

/**
 * Why a stamped file stops agreeing with itself or with its proposal. Oxagen
 * writes the file whole, so a mismatch almost always means someone changed
 * it on the pull request, and the fix is in Oxagen, not in the file. A review
 * bot's accepted suggestion is the common case: it edits `statement` and
 * leaves `record_hash` stamped over the old words.
 */
const EDITED_ON_PR =
  "The file changed after Oxagen wrote it, usually through an edit or an accepted review suggestion on this pull request. Change the record in Oxagen, not on the pull request.";

function checkRecordHash(ctx: CheckContext): CheckOutcome {
  const parsed = parseChecked(ctx.fileText);
  if (!parsed.ok) return { ok: false, summary: parsed.reason };
  const record = parsed.file.record[0]!;
  const expected = stampRecordObject(parsed.file.raw[0]!);
  if (expected.record_hash !== record.record_hash) {
    return {
      ok: false,
      summary: `recomputed over the canonical bytes · ${expected.record_hash} does not match the file's ${record.record_hash}. ${EDITED_ON_PR}`,
    };
  }
  if (expected.record_id !== record.record_id) {
    return {
      ok: false,
      summary: `record_id ${record.record_id} is not derived from the content (expected ${expected.record_id}). ${EDITED_ON_PR}`,
    };
  }
  return {
    ok: true,
    summary: `recomputed over the canonical bytes · ${record.record_hash} matches the file`,
  };
}

// The secret and personal-data scanner moved to @oxagen/steering-check
// unchanged. The callers that import it from here still can.
export { findSecretsAndPii };

function scanForSecretsAndPii(fields: Record<string, string>): string[] {
  const findings: string[] = [];
  for (const [field, text] of Object.entries(fields)) {
    for (const label of findSecretsAndPii(text))
      findings.push(`${label} in ${field}`);
  }
  return findings;
}

function checkSecretPiiScan(ctx: CheckContext): CheckOutcome {
  const findings = scanForSecretsAndPii({
    statement: ctx.proposal.statement,
    rationale: ctx.proposal.rationale,
    evidence: ctx.proposal.evidenceLinks.join("\n"),
    file: ctx.fileText,
  });
  if (findings.length > 0) {
    return {
      ok: false,
      summary: `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings.join("; ")}`,
    };
  }
  return {
    ok: true,
    summary: "statement, rationale and evidence scanned · 0 findings",
  };
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function checkConflictAgainstActive(ctx: CheckContext): CheckOutcome {
  const others = ctx.activeRecords.filter(
    (r) => r.lineageId !== ctx.proposal.lineageId,
  );
  const mine = ctx.proposal;
  if (mine.kind === "constraint" && mine.constraintEffect) {
    const opposite = mine.constraintEffect === "forbid" ? "require" : "forbid";
    const same = ctx.activeRecords.find(
      (r) =>
        r.lineageId === mine.lineageId &&
        r.kind === "constraint" &&
        r.constraintEffect === opposite,
    );
    if (same) {
      return {
        ok: false,
        summary: `the active constraint on ${mine.lineageId} is ${opposite}; a revision cannot flip it to ${mine.constraintEffect} in place — retire it first`,
      };
    }
    const clash = others.find(
      (r) =>
        r.kind === "constraint" &&
        r.constraintEffect === opposite &&
        r.statement !== null &&
        normalize(r.statement) === normalize(mine.statement),
    );
    if (clash) {
      return {
        ok: false,
        summary: `${clash.lineageId} is an active ${opposite} on the same statement; a ${mine.constraintEffect} against it cannot both hold`,
      };
    }
  }
  return {
    ok: true,
    summary: `${others.length} active record${others.length === 1 ? "" : "s"} checked · no opposite constraint on this lineage or statement`,
  };
}

/**
 * The file's classification is the proposal's: kind, force, sharing scope
 * and statement, and the label when the proposal sets one. The registry is
 * written from the proposal row at merge, so a file that disagrees with it
 * must not pass.
 */
function checkConstraintEffect(ctx: CheckContext): CheckOutcome {
  const parsed = parseChecked(ctx.fileText);
  if (!parsed.ok) return { ok: false, summary: parsed.reason };
  const record = parsed.file.record[0]!;
  const kind = record.kind;
  const disagreements = (
    [
      ["kind", kind, ctx.proposal.kind],
      ["steering.force", record.steering.force, ctx.proposal.force],
      ["sharing_scope", record.sharing_scope, ctx.proposal.sharingScope],
      ["statement", record.statement, ctx.proposal.statement],
      ...(ctx.proposal.label
        ? ([["label", record.label ?? null, ctx.proposal.label]] as const)
        : []),
    ] as const
  ).filter(([, inFile, inProposal]) => inFile !== inProposal);
  if (disagreements.length > 0) {
    return {
      ok: false,
      summary: `${disagreements
        .map(
          ([field, inFile, inProposal]) =>
            `the file's ${field} is ${JSON.stringify(inFile)}; the proposal's is ${JSON.stringify(inProposal)}`,
        )
        .join("; ")}. ${EDITED_ON_PR}`,
    };
  }
  const effect = ctx.proposal.constraintEffect;
  if (kind === "constraint") {
    if (effect !== "require" && effect !== "forbid") {
      return {
        ok: false,
        summary: `a constraint's effect is require or forbid; this one carries ${JSON.stringify(effect)}`,
      };
    }
    return {
      ok: true,
      summary: `constraint_effect = ${effect} · grants nothing`,
    };
  }
  if (effect !== null) {
    return {
      ok: false,
      summary: `a ${kind} carries no constraint_effect; this one carries ${effect}`,
    };
  }
  return {
    ok: true,
    summary: `${kind} · no constraint_effect · grants nothing`,
  };
}

export const CHECKS: Record<CheckName, (ctx: CheckContext) => CheckOutcome> = {
  schema: checkSchema,
  lineage_uniqueness: checkLineageUniqueness,
  record_hash: checkRecordHash,
  secret_pii_scan: checkSecretPiiScan,
  conflict_against_active: checkConflictAgainstActive,
  constraint_effect: checkConstraintEffect,
};

/** Human labels for the GitHub check runs and the page. */
export const CHECK_TITLES: Record<CheckName, string> = {
  schema: "Schema",
  lineage_uniqueness: "Lineage uniqueness",
  record_hash: "record_hash recomputation",
  secret_pii_scan: "Secret and PII scan",
  conflict_against_active: "Conflict against active records",
  constraint_effect: "constraint_effect ∈ {require, forbid}",
};

/**
 * Run the six checks in order, one at a time: `start` is awaited before a
 * check runs and `finish` after, so the caller can persist the running state
 * and then the outcome, and mirror each to GitHub before the next one starts.
 * Every check runs even after a failure, so the PR shows everything that is
 * wrong at once.
 */
export async function runChecks(
  ctx: CheckContext,
  hooks: {
    start: (name: CheckName) => Promise<void>;
    finish: (name: CheckName, outcome: CheckOutcome) => Promise<void>;
  },
): Promise<boolean> {
  let allPassed = true;
  for (const name of CHECK_NAMES) {
    await hooks.start(name);
    const outcome = CHECKS[name](ctx);
    if (!outcome.ok) allPassed = false;
    await hooks.finish(name, outcome);
  }
  return allPassed;
}

/**
 * Reads a steering repo at one commit. Pass a commit SHA as `ref`, so every
 * read in one check run sees the same tree.
 */
export interface SteeringTreeHost {
  /** Every file path in the steering layout at `ref`. */
  listFiles(ref: string): Promise<string[]>;
  /** The file's text at `ref`, or null when `ref` has no such file. */
  readFile(ref: string, path: string): Promise<string | null>;
}

/** How many file reads loadSteeringTree() keeps in flight at once. */
export const STEERING_TREE_READS_AT_ONCE = 8;

/** The files at the root of a steering repo that the checks read. */
const STEERING_ROOT_FILES: readonly string[] = [
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  README_PATH,
  GITATTRIBUTES_PATH,
  WORKSPACE_TOML_PATH,
];

/** The folders of a steering repo. The checks read every file under them. */
const STEERING_TREE_DIRS: readonly string[] = [
  AGENTS_DIR,
  STEERING_DIR,
  TOOLS_DIR,
  POLICY_DIR,
];

/**
 * A SteeringTreeHost over the host a workspace steers through. It lists every
 * file under agents/, steering/, tools/, and policy/, and each root file the
 * checks read. The host lists folders only, so a root file is found by
 * reading it. The adapter keeps that text for the one readFile() call that
 * follows, so each root file is read once.
 */
export function steeringTreeHost(
  host: Pick<SteeringHost, "listFiles" | "readFile">,
  repo: SteeringRepository,
): SteeringTreeHost {
  const rootTexts = new Map<string, string>();
  const key = (ref: string, path: string) => `${ref}\n${path}`;
  return {
    async listFiles(ref) {
      const [listed, roots] = await Promise.all([
        Promise.all(
          STEERING_TREE_DIRS.map((dir) => host.listFiles(repo, ref, dir)),
        ),
        Promise.all(
          STEERING_ROOT_FILES.map(async (path) => {
            const text = await host.readFile(repo, path, ref);
            if (text === null) return null;
            rootTexts.set(key(ref, path), text);
            return path;
          }),
        ),
      ]);
      return [
        ...roots.filter((path): path is string => path !== null),
        ...listed.flat(),
      ];
    },
    async readFile(ref, path) {
      const kept = rootTexts.get(key(ref, path));
      if (kept === undefined) return host.readFile(repo, path, ref);
      rootTexts.delete(key(ref, path));
      return kept;
    },
  };
}

/**
 * Every file the host lists at `ref`, keyed by path in path order. It keeps
 * at most STEERING_TREE_READS_AT_ONCE reads in flight. A listed file that
 * reads as missing means the ref moved during the read, so it throws rather
 * than check a tree with a file left out.
 */
export async function loadSteeringTree(
  host: SteeringTreeHost,
  ref: string,
): Promise<SteeringTree> {
  const paths = [...new Set(await host.listFiles(ref))].sort();
  const texts: string[] = new Array<string>(paths.length);
  let next = 0;
  const reader = async () => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      const path = paths[index] as string;
      const text = await host.readFile(ref, path);
      if (text === null) {
        throw new HandlerError({
          code: "conflict",
          reason: "steering_tree_moved",
          message: `Oxagen listed ${path} at ${ref} and then could not read it. The branch may have moved during the read. Run the checks again.`,
        });
      }
      texts[index] = text;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(STEERING_TREE_READS_AT_ONCE, paths.length) },
      reader,
    ),
  );
  return new Map(paths.map((path, index) => [path, texts[index] as string]));
}

/** What checkSteeringChange() reads: two commits and what the checks take besides the trees. */
export interface SteeringChangeInput extends Omit<CheckInput, "files" | "base"> {
  host: SteeringTreeHost;
  /** The steering PR's head commit. */
  head: string;
  /**
   * The production branch commit the steering PR merges into. Null checks
   * the head tree whole, as for a repository's first publish.
   */
  base: string | null;
}

/**
 * Run the steering PR checks on one change. It loads the head tree, then the
 * base tree, and passes both to @oxagen/steering-check's
 * runChecksWithServers(), which also compiles and replays each changed server
 * folder. The report passes when no finding is an error. It throws only when
 * a tree cannot be read.
 */
export async function checkSteeringChange(
  input: SteeringChangeInput,
): Promise<CheckReport> {
  const { host, head, base, ...rest } = input;
  const files = await loadSteeringTree(host, head);
  const baseTree = base === null ? null : await loadSteeringTree(host, base);
  return runChecksWithServers({ ...rest, files, base: baseTree });
}
