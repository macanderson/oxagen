// context.steering.checks.ts — the six §10.3 checks a Context PR passes
// before Oxagen merges it (ADR-061), the same rules as `stella context
// validate`: schema, lineage uniqueness, record_hash recomputation, a secret
// and PII scan, conflict against active records, and constraint_effect. Each
// is a pure function of the committed file and what the registry holds, so
// each has a failing fixture in context.steering.checks.test.ts.
import {
  CHECK_NAMES,
  type CheckName,
  type ConstraintEffect,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { CONTEXT_RECORD_LABEL_MAX } from "@oxagen/oxagen/context-record-label";
import {
  RECORD_SCHEMA_TAG,
  parseRecordFile,
  recordFilePath,
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
    // Optional: a file written before ADR-174 has none. Present, it is a name
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
  if (ctx.path !== recordFilePath(lineage)) {
    return {
      ok: false,
      summary: `${ctx.path} does not hold lineage ${lineage}; the file stem is the lineage id`,
    };
  }
  const published = ctx.published;
  if (published?.path && published.path !== ctx.path) {
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

function checkRecordHash(ctx: CheckContext): CheckOutcome {
  const parsed = parseChecked(ctx.fileText);
  if (!parsed.ok) return { ok: false, summary: parsed.reason };
  const record = parsed.file.record[0]!;
  const expected = stampRecordObject(parsed.file.raw[0]!);
  if (expected.record_hash !== record.record_hash) {
    return {
      ok: false,
      summary: `recomputed over the canonical bytes · ${expected.record_hash} does not match the file's ${record.record_hash}`,
    };
  }
  if (expected.record_id !== record.record_id) {
    return {
      ok: false,
      summary: `record_id ${record.record_id} is not derived from the content (expected ${expected.record_id})`,
    };
  }
  return {
    ok: true,
    summary: `recomputed over the canonical bytes · ${record.record_hash} matches the file`,
  };
}

// Secrets, mirroring the detector Stella's `stella context validate` reuses
// (stella-learn/src/redact.rs): a vendor-prefixed token, a JWT by shape, a
// long mixed-case opaque blob, a value after a sensitive key name, a PEM
// block. PII: an email address, a US social security number, a payment card
// number that passes Luhn.
const SECRET_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxs-",
  "npm_",
  "dop_v1_",
  "doo_v1_",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "sk-",
  "AKIA",
  "ASIA",
  "AIza",
  "ya29.",
  "SG.",
  "hf_",
  "shpat_",
  "sq0atp-",
  "sq0csp-",
];
const SENSITIVE_KEY_MARKERS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "authorization",
  "auth_token",
  "bearer",
  "session_id",
  "client_secret",
];
const TOKEN = /[A-Za-z0-9_\-./+~]+/g;

function isJwt(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    parts[0]!.startsWith("eyJ") &&
    parts[0]!.length >= 8 &&
    parts[1]!.length >= 8 &&
    parts[2]!.length > 0
  );
}

function isHighEntropyBlob(token: string): boolean {
  if (token.length < 32 || token.includes("/") || token.includes("."))
    return false;
  if (!/^[A-Za-z0-9_\-+~]+$/.test(token)) return false;
  return /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

function isSecretToken(token: string): boolean {
  if (token.length < 8) return false;
  if (
    SECRET_PREFIXES.some(
      (p) => token.startsWith(p) && token.length > p.length + 4,
    )
  ) {
    return true;
  }
  return isJwt(token) || isHighEntropyBlob(token);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The findings in one text, each naming what was found. */
export function findSecretsAndPii(text: string): string[] {
  const findings: string[] = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text))
    findings.push("private key block");
  for (const token of text.match(TOKEN) ?? []) {
    if (isSecretToken(token)) {
      findings.push("credential token");
      break;
    }
  }
  const keyed =
    /([A-Za-z_][A-Za-z0-9_-]*)\s*[=:]\s*["']?([A-Za-z0-9_\-./+~]{8,})/g;
  for (const m of text.matchAll(keyed)) {
    const key = m[1]!.toLowerCase();
    if (
      !key.endsWith("_env") &&
      SENSITIVE_KEY_MARKERS.some((k) => key.includes(k))
    ) {
      findings.push(`value after sensitive key ${m[1]}`);
      break;
    }
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text))
    findings.push("email address");
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text))
    findings.push("US social security number");
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      findings.push("payment card number");
      break;
    }
  }
  return findings;
}

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
      summary: disagreements
        .map(
          ([field, inFile, inProposal]) =>
            `the file's ${field} is ${JSON.stringify(inFile)}; the proposal's is ${JSON.stringify(inProposal)}`,
        )
        .join("; "),
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
