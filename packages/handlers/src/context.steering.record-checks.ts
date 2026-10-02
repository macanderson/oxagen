// context.steering.record-checks.ts: four of the six steering PR checks, for
// a steering record (#4731).
//
// In a steering repo, open_steering_pr writes the proposal as a steering
// record (context.steering.record.ts). Schema, lineage uniqueness, the hash,
// and the classification read that file as steering-record/v1 here. The
// secret and PII scan and the conflict check read only the proposal and the
// registry, so both layouts share them in context.steering.checks.ts, which
// picks this table for any path the steering layout reads as a record.
import type { CheckName } from "@oxagen/oxagen/contracts/context.steering.shared";
import { recordLineageFromPath } from "@oxagen/oxagen/steering-repo/paths";
import {
  readSteeringRecord,
  recordStatement,
  type SteeringRecord,
} from "@oxagen/oxagen/steering-repo/record";
import type { CheckContext, CheckOutcome } from "./context.steering.checks";
import {
  isSteeringRecordPath,
  kindCarriesProposal,
  steeringRecordKind,
} from "./context.steering.record";
import { stampRecordText } from "./steering-repo/stamp";

/**
 * Why a file Oxagen wrote stops agreeing with itself or with its proposal.
 * Oxagen writes the file whole, so a mismatch almost always means someone
 * changed it on the pull request, and the fix is in Oxagen, not in the file.
 * A review bot's accepted suggestion is the common case: it edits the
 * statement and leaves the hash stamped over the old words.
 */
export const EDITED_ON_PR =
  "The file changed after Oxagen wrote it, usually through an edit or an accepted review suggestion on this pull request. Change the record in Oxagen, not on the pull request.";

type Read =
  | { ok: true; record: SteeringRecord; body: string }
  | { ok: false; summary: string };

function readRecord(ctx: CheckContext): Read {
  const read = readSteeringRecord(ctx.fileText);
  if (read.ok) return { ok: true, record: read.record, body: read.body };
  return {
    ok: false,
    summary: read.issues
      .map((issue) =>
        issue.line === null ? issue.message : `line ${issue.line}: ${issue.message}`,
      )
      .join("; "),
  };
}

/** The statement as the file's body holds it: LF line endings, trimmed. */
const statementOf = (text: string) => text.replace(/\r\n?/g, "\n").trim();

function checkSchema(ctx: CheckContext): CheckOutcome {
  const others = ctx.changedPaths.filter((p) => p !== ctx.path);
  if (others.length > 0) {
    return {
      ok: false,
      summary: `the pull request also changes ${others.join(", ")}; a steering PR changes ${ctx.path} and nothing else`,
    };
  }
  const read = readRecord(ctx);
  if (!read.ok) return read;
  return { ok: true, summary: "steering-record/v1 valid: 1 file, 1 record" };
}

function checkLineageUniqueness(ctx: CheckContext): CheckOutcome {
  const read = readRecord(ctx);
  if (!read.ok) return read;
  const lineage = read.record.lineage;
  if (lineage !== ctx.proposal.lineageId) {
    return {
      ok: false,
      summary: `the file declares ${lineage}; the proposal is about ${ctx.proposal.lineageId}`,
    };
  }
  if (!isSteeringRecordPath(ctx.path)) {
    return {
      ok: false,
      summary: `${ctx.path} is not a steering record path: a .md file under steering/, outside promotions/ and skills/`,
    };
  }
  if (recordLineageFromPath(ctx.path) !== lineage) {
    return {
      ok: false,
      summary: `${ctx.path} is not named for ${lineage}; a steering record's file is <lineage>.md`,
    };
  }
  const published = ctx.published;
  if (
    published?.path &&
    isSteeringRecordPath(published.path) &&
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
      summary: `revises the published record on ${lineage} (version ${published.version ?? "?"}) at ${ctx.path}`,
    };
  }
  return {
    ok: true,
    summary: `no published record holds ${lineage}; this proposal is its only holder`,
  };
}

/**
 * A steering record carries no id or hash until its steering PR merges and
 * Oxagen stamps it. A file that carries both must carry the ones its content
 * gives, and a file with only one of them was edited by hand.
 */
function checkRecordHash(ctx: CheckContext): CheckOutcome {
  const read = readRecord(ctx);
  if (!read.ok) return read;
  const { id, hash } = read.record;
  if (id === undefined && hash === undefined) {
    return {
      ok: true,
      summary: "no id or hash yet; Oxagen writes both when the steering PR merges",
    };
  }
  if (id === undefined || hash === undefined) {
    return {
      ok: false,
      summary: `the file carries ${id === undefined ? "a hash and no id" : "an id and no hash"}. ${EDITED_ON_PR}`,
    };
  }
  const expected = stampRecordText(ctx.fileText);
  if (!expected.ok) return { ok: false, summary: expected.message };
  if (expected.hash !== hash) {
    return {
      ok: false,
      summary: `recomputed over the record ${expected.hash} does not match the file's ${hash}. ${EDITED_ON_PR}`,
    };
  }
  if (expected.id !== id) {
    return {
      ok: false,
      summary: `id ${id} is not derived from the content (expected ${expected.id}). ${EDITED_ON_PR}`,
    };
  }
  return {
    ok: true,
    summary: `recomputed over the record: ${hash} matches the file`,
  };
}

/**
 * The file's classification is the proposal's: kind, force, scope and
 * statement, and the label when the proposal sets one. A rule may be a
 * business rule or a code rule. The registry is written from the proposal
 * row at merge, so a file that disagrees with it must not pass.
 */
function checkConstraintEffect(ctx: CheckContext): CheckOutcome {
  const read = readRecord(ctx);
  if (!read.ok) return read;
  const { record } = read;
  const proposal = ctx.proposal;
  const disagreements: Array<readonly [string, unknown, unknown]> = [];
  if (!kindCarriesProposal(proposal.kind, record.kind)) {
    disagreements.push(["kind", record.kind, steeringRecordKind(proposal.kind)]);
  }
  if (record.force !== proposal.force) {
    disagreements.push(["force", record.force, proposal.force]);
  }
  if (record.scope !== proposal.sharingScope) {
    disagreements.push(["scope", record.scope, proposal.sharingScope]);
  }
  const statement = recordStatement(read.body).trim();
  if (statement !== statementOf(proposal.statement)) {
    disagreements.push(["statement", statement, statementOf(proposal.statement)]);
  }
  if (proposal.label && record.label !== proposal.label) {
    disagreements.push(["label", record.label, proposal.label]);
  }
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
  const effect = proposal.constraintEffect;
  const inFile = record.effect ?? null;
  if (record.kind === "constraint") {
    if (effect !== "require" && effect !== "forbid") {
      return {
        ok: false,
        summary: `a constraint's effect is require or forbid; this proposal carries ${JSON.stringify(effect)}`,
      };
    }
    if (inFile !== effect) {
      return {
        ok: false,
        summary: `the file's effect is ${JSON.stringify(inFile)}; the proposal's is ${JSON.stringify(effect)}. ${EDITED_ON_PR}`,
      };
    }
    return { ok: true, summary: `effect: ${effect}. A record grants nothing.` };
  }
  if (effect !== null || inFile !== null) {
    return {
      ok: false,
      summary: `a ${record.kind} carries no effect; this one carries ${effect ?? inFile}`,
    };
  }
  return {
    ok: true,
    summary: `${record.kind}, with no effect. A record grants nothing.`,
  };
}

/** The checks a steering record runs in place of the TOML file's four. */
export const STEERING_RECORD_CHECKS: Pick<
  Record<CheckName, (ctx: CheckContext) => CheckOutcome>,
  "schema" | "lineage_uniqueness" | "record_hash" | "constraint_effect"
> = {
  schema: checkSchema,
  lineage_uniqueness: checkLineageUniqueness,
  record_hash: checkRecordHash,
  constraint_effect: checkConstraintEffect,
};
