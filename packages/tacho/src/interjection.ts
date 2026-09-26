/**
 * The bodies of the frames a host seals when a session starts in a
 * repository its workspace has not bound, and holds the loop to ask a person
 * what to do (#3941).
 *
 * The frames, in the order a host seals them:
 *
 * 1. `repo.unknown`: the session's remote matched no repository the bundle's
 *    `unbound_repo.bound_remote_digests` lists.
 * 2. `control.interject`: the host held the loop and asked. The body carries
 *    the question exactly as the harness showed it and the two paths a person
 *    can take.
 * 3. `control.answer`: a person answered, or the timeout answered `deny`.
 * 4. After a link: `repo.bound`. After a create: `workspace.created`, then
 *    `repo.bound`.
 * 5. `skills.resolved`: which skills the session may load once the question
 *    is settled.
 *
 * `KIND_BODIES` in `envelope.ts` accepts each of these kinds with any body,
 * so an old reader never refuses a new field. The strict schemas are here.
 * The host parses a body with its schema before it seals the frame, and the
 * control plane's ingest parses it again before it writes a row.
 *
 * Members are snake_case, as every sealed body is. The answer rides to the
 * host inside a `message` command's `payload.interjection`, whose shape is
 * `interjectionAnswerPayloadSchema`, so no new command kind reaches an old
 * host.
 */
import { z } from "zod";
import { SHA256_DIGEST_PATTERN } from "./digest";
import { isProtocolTimestamp } from "./timestamp";

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const timestamp = z.string().refine(isProtocolTimestamp, "protocol timestamp");
const count = z.number().int().nonnegative();
/** A skills configuration version as the control plane names it. */
const configVersion = z.string().min(1).max(64).nullable();
const workspaceSlug = z.string().min(1).max(64);

/**
 * The key a host mints for one interjection: a ULID, the form `ulid()` in
 * `ids.ts` returns. The host seals it before the control plane has a row, so
 * every later frame and the answer name the interjection by this key.
 */
export const interjectionKeySchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "a ULID");

/** A receipt the control plane mints when it records an answer. */
export const INTERJECTION_RECEIPT_ID_PATTERN = /^rcp_[0-9a-z]+$/;

/** The longest question a host may show, in characters. */
export const INTERJECTION_QUESTION_MAX = 2_000;

/**
 * How an interjection was settled. `link` binds the repository to the
 * workspace, `create` makes a new workspace for it, and `deny` runs the
 * session with no skills.
 */
export const INTERJECTION_PATHS = ["link", "create", "deny"] as const;
export type InterjectionPath = (typeof INTERJECTION_PATHS)[number];

/** Who settled it: a person, or the timeout, which always answers `deny`. */
export const INTERJECTION_ANSWER_SOURCES = ["person", "timeout"] as const;
export type InterjectionAnswerSource =
  (typeof INTERJECTION_ANSWER_SOURCES)[number];

/**
 * Why `skills.resolved` holds the count it holds. `skills_off` is a new
 * workspace, whose skills start off. `denied` is a deny answer or a
 * timeout. `resolved` is the resolver's own count.
 */
export const SKILLS_RESOLVED_REASONS = [
  "skills_off",
  "denied",
  "resolved",
] as const;

/** `repo.unknown`: the session's remote matched no bound repository. */
export const repoUnknownBodySchema = z
  .object({
    /** sha256 of `canonicalRemote(origin)`; the remote itself never leaves the host. */
    remote_digest: digest,
    /** sha256 of `foldedRemote(canonicalRemote(origin))`; absent when the host does not fold. */
    remote_digest_folded: digest.optional(),
    head_sha: z.string().max(512).optional(),
    /** The bundle asked only because the workspace has skills on. */
    skills_enabled: z.literal(true),
    /** The bundle's `unbound_repo.policy`. */
    unbound_repo: z.literal("ask"),
    /** The skills configuration the bundle carried; null when none was named. */
    config_version: configVersion,
  })
  .strict();
export type RepoUnknownBody = z.output<typeof repoUnknownBodySchema>;

/** The link path: bind the repository to the host's workspace. */
const interjectLinkPathSchema = z
  .object({
    path: z.literal("link"),
    workspace_slug: workspaceSlug,
    config_version: configVersion,
    /** Skills the workspace's configuration pins; null when not counted. */
    skills_pinned: count.nullable(),
    /** Repositories the workspace already links; null when not counted. */
    linked_repositories: count.nullable(),
  })
  .strict();

/** The create path: a new workspace for the repository, with skills off. */
const interjectCreatePathSchema = z
  .object({
    path: z.literal("create"),
    /** From the repository's name; null when the host could not read one. */
    proposed_name: z.string().min(1).max(120).nullable(),
    proposed_slug: workspaceSlug.nullable(),
    skills_enabled: z.literal(false),
  })
  .strict();

/**
 * `control.interject`: the host held the loop and asked a person. The
 * question is the exact text the harness showed. `list_interjections`
 * returns this body as the host sealed it.
 */
export const interjectBodySchema = z
  .object({
    interjection_key: interjectionKeySchema,
    reason: z.literal("repo_unknown"),
    question: z.string().min(1).max(INTERJECTION_QUESTION_MAX),
    remote_digest: digest,
    remote_digest_folded: digest.optional(),
    /** How long the host waits, from the bundle's `unbound_repo.timeout_ms`. */
    timeout_ms: z.number().int().positive(),
    /** The host's clock plus `timeout_ms`. The control plane keeps its own deadline. */
    expires_at: timestamp,
    /** What the timeout answers. */
    on_timeout: z.literal("deny"),
    /** The two paths a person can take, link first. Deny needs no path. */
    paths: z.tuple([interjectLinkPathSchema, interjectCreatePathSchema]),
  })
  .strict();
export type InterjectBody = z.output<typeof interjectBodySchema>;

/** `control.answer`: how the interjection was settled. */
export const answerBodySchema = z
  .object({
    interjection_key: interjectionKeySchema,
    /** The control plane's row (`inj_…`); absent on a timeout the host answered alone. */
    interjection_id: z.string().regex(/^inj_[0-9a-z]+$/).optional(),
    path: z.enum(INTERJECTION_PATHS),
    source: z.enum(INTERJECTION_ANSWER_SOURCES),
    /** The receipt the control plane recorded; absent on a host-side timeout. */
    receipt_id: z.string().regex(INTERJECTION_RECEIPT_ID_PATTERN).optional(),
    /** The person who answered (`usr_…`); absent on a timeout. */
    answered_by: z.string().regex(/^usr_[0-9a-z]+$/).optional(),
    /** The `message` command that carried the answer (`tcm_…`). */
    command_id: z.string().regex(/^tcm_[0-9a-z]+$/).optional(),
  })
  .strict();
export type AnswerBody = z.output<typeof answerBodySchema>;

/** `repo.bound`: the repository is now bound to a workspace. */
export const repoBoundBodySchema = z
  .object({
    interjection_key: interjectionKeySchema,
    binding_id: z.string().min(1).max(64),
    workspace_slug: workspaceSlug,
    role: z.enum(["linked", "main"]),
  })
  .strict();
export type RepoBoundBody = z.output<typeof repoBoundBodySchema>;

/** `workspace.created`: the create path made a workspace, with skills off. */
export const workspaceCreatedBodySchema = z
  .object({
    interjection_key: interjectionKeySchema,
    workspace_id: z.string().min(1).max(64),
    workspace_slug: workspaceSlug,
    skills_enabled: z.literal(false),
  })
  .strict();
export type WorkspaceCreatedBody = z.output<typeof workspaceCreatedBodySchema>;

/** `skills.resolved`: which skills the session may load. */
export const skillsResolvedBodySchema = z
  .object({
    /** The interjection that settled it; absent when no question was asked. */
    interjection_key: interjectionKeySchema.optional(),
    config_version: configVersion,
    /** Skills the session may load. */
    in_scope: count,
    /** Skills the configuration holds back; null until the catalog read counts them (#3098). */
    withheld: count.nullable(),
    reason: z.enum(SKILLS_RESOLVED_REASONS),
  })
  .strict();
export type SkillsResolvedBody = z.output<typeof skillsResolvedBodySchema>;

/**
 * The answer as a `message` command carries it to the host, in
 * `payload.interjection`. The host applies it only when `key` matches the
 * interjection it holds. A host built before #3941 ignores the member and
 * delivers the message text as before.
 */
export const interjectionAnswerPayloadSchema = z
  .object({
    key: interjectionKeySchema,
    path: z.enum(INTERJECTION_PATHS),
    source: z.enum(INTERJECTION_ANSWER_SOURCES),
    receipt_id: z.string().regex(INTERJECTION_RECEIPT_ID_PATTERN),
    /** The person who answered (`usr_…`); null on a timeout. */
    answered_by: z
      .string()
      .regex(/^usr_[0-9a-z]+$/)
      .nullable(),
    /** Set on a link or create answer. */
    binding_id: z.string().min(1).max(64).optional(),
    /** Set on a create answer. */
    workspace_id: z.string().min(1).max(64).optional(),
    workspace_slug: workspaceSlug.optional(),
  })
  .strict();
export type InterjectionAnswerPayload = z.output<
  typeof interjectionAnswerPayloadSchema
>;
