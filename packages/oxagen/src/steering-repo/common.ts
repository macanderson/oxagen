// common.ts: the zod shapes the steering repo schemas share. Each one checks
// a name the Shared contract fixes, with the pattern from names.ts.
import { z } from "zod";
import { CONTEXT_RECORD_LINEAGE } from "../context-record-label";
import { RESERVED_WORKSPACE_SLUGS, workspaceSlug } from "../workspace-slug";
import { withJsonSchema } from "./json-schema";
import {
  CREDENTIAL_REF_PATTERN,
  REPO_REF_PATTERN,
  TOOL_NAME_MAX,
  TOOL_NAME_PATTERN,
  TOOL_REF_PATTERN,
  TOOL_TARGET_PATTERN,
} from "./names";

/** The idea a record states, and the name of an agent file. */
export const lineageSchema = z
  .string()
  .regex(
    CONTEXT_RECORD_LINEAGE,
    "a lineage is lowercase letters, digits, dots, and hyphens, and starts and ends with a letter or digit",
  );

/** `<host>/<owner>/<name>`, lowercase. */
export const repoRefSchema = z
  .string()
  .regex(
    REPO_REF_PATTERN,
    "a repository is <host>/<owner>/<name> in lowercase, such as github.com/a-intel/platform",
  );

/** `oxagen:credential/<name>`. */
export const credentialRefSchema = z
  .string()
  .regex(
    CREDENTIAL_REF_PATTERN,
    "a credential is oxagen:credential/<name>, the name in lowercase letters, digits, and hyphens",
  );

/** `<server>__<tool>`. */
export const toolNameSchema = z
  .string()
  .max(TOOL_NAME_MAX)
  .regex(
    TOOL_NAME_PATTERN,
    "a tool name is <server>__<tool> in lowercase letters, digits, and underscores, 64 characters at most",
  );

/** A tool name, or `<server>__*` for every imported tool of one server. */
export const toolTargetSchema = z
  .string()
  .max(TOOL_NAME_MAX)
  .regex(
    TOOL_TARGET_PATTERN,
    "a tool target is <server>__<tool> or <server>__*",
  );

/** A tool name, optionally pinned to a lock version: `billing__create_refund@3`. */
export const toolRefSchema = z
  .string()
  .regex(
    TOOL_REF_PATTERN,
    "a tool reference is <server>__<tool>, optionally followed by @<version>",
  );

/** `rec_<lineage slug>_<12 hex>`, written by Oxagen. */
export const recordIdSchema = z.string().regex(/^rec_[a-z0-9_]+_[0-9a-f]{12}$/);

/** `sha256:` and 64 lowercase hex characters. */
export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A git object id: 40 hex characters, or 64 in a SHA-256 repository. */
export const gitObjectIdSchema = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

/** An ISO 8601 time with its offset. */
export const instantSchema = z.string().datetime({ offset: true });

/** An organization's slug, the owner of every record lineage in it. */
export const organizationSlugSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only");

/** A workspace's slug, with the route segments a workspace may not take. */
export const workspaceSlugSchema = withJsonSchema(workspaceSlug, {
  not: { enum: [...RESERVED_WORKSPACE_SLUGS] },
});

/** A run's public id: `run_01K5QK7D`. */
export const runIdSchema = z.string().regex(/^run_[0-9A-Za-z]+$/);

/** A frame of a run, the evidence a memory cites: `frame:run_01K5QK7D/88`. */
export const frameRefSchema = z
  .string()
  .regex(/^frame:run_[0-9A-Za-z]+\/[0-9]+$/);

/** A path in a repository: relative, with no empty, `.`, or `..` segment. */
export const repoPathSchema = z
  .string()
  .regex(/^(?!\/)(?!.*\/$)(?!.*\/\/)(?!(?:.*\/)?\.\.?(?:\/|$)).+$/);

/** An Oxagen member or team, or `oxagen` for an action Oxagen took on its own. */
export const actorSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
