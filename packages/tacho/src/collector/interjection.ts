/**
 * The host's side of the repository question (#3941).
 *
 * When the bundle carries `unbound_repo`, the workspace has skills on and the
 * host holds a session whose repository no workspace in the organisation has
 * bound. At the session's first prompt, before any model call, the host
 * digests the `origin` remote and looks for it in
 * `unbound_repo.bound_remote_digests`. When it is not there, the host seals
 * `repo.unknown` and `control.interject`, and refuses the prompt with the
 * question. Every prompt after it is refused with the same question until the
 * question is settled:
 *
 *  - an answer arrives as a `message` command whose `payload.interjection`
 *    names the key the host minted (`applyInterjectionAnswer`). The host
 *    seals `control.answer` and what the answer did (`repo.bound`,
 *    `workspace.created`, `skills.resolved`), and lets prompts through again.
 *  - the deadline passes with no answer (`expireInterjection`). The host
 *    answers `deny` itself, with source `timeout`, seals `skills.resolved`
 *    with nothing in scope, and tells the agent why at the prompt it lets
 *    through.
 *
 * The bodies are parsed with their strict schemas (`../interjection`) before
 * they are sealed. A body that fails its schema raises no question: a broken
 * question must not hold an operator's session.
 */
import type { TachoEvent, TachoKind } from "../envelope";
import { ulid } from "../ids";
import {
  answerBodySchema,
  type InterjectionAnswerPayload,
  type InterjectionAnswerSource,
  type InterjectionPath,
  interjectBodySchema,
  interjectionAnswerPayloadSchema,
  repoBoundBodySchema,
  repoUnknownBodySchema,
  skillsResolvedBodySchema,
  workspaceCreatedBodySchema,
} from "../interjection";
import { toProtocolTimestamp } from "../timestamp";
import type { PolicyBundle, TachoHarness } from "../wire";
import type { RepositoryRemote } from "./git-facts";
import type { HeldInterjection, SessionRecord } from "./registry";

type UnboundRepo = NonNullable<PolicyBundle["unbound_repo"]>;

/** How a question was settled, as `control.answer` records it. */
interface AnswerFields {
  path: InterjectionPath;
  source: InterjectionAnswerSource;
  receipt_id?: string;
  answered_by?: string;
  command_id?: string;
}

/** The fields every frame here is sealed with. */
export interface InterjectionFrameFields {
  hook_event_name?: string;
  attrs?: Record<string, string>;
}

/** The pattern a slug must match to be proposed for a new workspace. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The bounds `create_workspace` holds a slug to. */
const SLUG_MIN = 2;
const SLUG_MAX = 40;
/** The longest name the create path proposes. */
const NAME_MAX = 120;

/**
 * Whether a harness shows the operator the reason a prompt was refused.
 * Stella reads only SessionStart's answer as text, so a refused prompt there
 * reaches the operator as a bare deny, and a question it cannot read would
 * hold the session with no way to learn why. Stella is asked nothing.
 */
export function showsRefusedPrompt(
  harness: TachoHarness | undefined,
): boolean {
  return harness !== "stella";
}

/** Whether the bundle counts the remote as bound, in either of its digests. */
export function isBound(
  clause: UnboundRepo,
  remote: RepositoryRemote,
): boolean {
  const bound = new Set(clause.bound_remote_digests);
  return (
    bound.has(remote.remote_digest) || bound.has(remote.remote_digest_folded)
  );
}

/**
 * The question as the harness shows it: what happened, the two paths, where
 * a person answers, and what the timeout does. The Run page reads the paths
 * from the frame's `paths`, and this text is what the operator saw.
 */
export function interjectionQuestion(clause: UnboundRepo): string {
  const minutes = Math.max(1, Math.round(clause.timeout_ms / 60_000));
  const slug = clause.workspace_slug;
  return (
    `Oxagen is holding this session before its first model call. ` +
    `It started in a repository that no workspace in your organization ` +
    `has bound, and skills are on for workspace ${slug}. ` +
    `Should Oxagen link this repository to ${slug}, or create a new ` +
    `workspace for it with skills off? A person with access answers on ` +
    `this run's page in Oxagen. With no answer in ${minutes} minutes, the ` +
    `session goes on without skills.`
  );
}

/**
 * A workspace slug made from a repository's name, or null when the name
 * leaves none `create_workspace` would accept.
 */
export function proposedSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug.length >= SLUG_MIN && SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Seal `repo.unknown` and then `control.interject`, and hold the session's
 * loop on the question. Answers the two frames, or undefined when a body
 * fails its schema, in which case nothing is sealed and nothing is held.
 */
export function raiseInterjection(
  record: SessionRecord,
  clause: UnboundRepo,
  remote: RepositoryRemote,
  now: number,
  fields: InterjectionFrameFields,
): TachoEvent[] | undefined {
  const key = ulid(now);
  const question = interjectionQuestion(clause);
  const expiresAt = toProtocolTimestamp(now + clause.timeout_ms);
  const name =
    remote.name !== undefined && remote.name.length <= NAME_MAX
      ? remote.name
      : null;
  const unknown = repoUnknownBodySchema.safeParse({
    remote_digest: remote.remote_digest,
    remote_digest_folded: remote.remote_digest_folded,
    ...(remote.head_sha !== undefined ? { head_sha: remote.head_sha } : {}),
    skills_enabled: true,
    unbound_repo: clause.policy,
    config_version: clause.config_version,
  });
  const interject = interjectBodySchema.safeParse({
    interjection_key: key,
    reason: "repo_unknown",
    question,
    remote_digest: remote.remote_digest,
    remote_digest_folded: remote.remote_digest_folded,
    timeout_ms: clause.timeout_ms,
    expires_at: expiresAt,
    on_timeout: "deny",
    paths: [
      {
        path: "link",
        workspace_slug: clause.workspace_slug,
        config_version: clause.config_version,
        skills_pinned: clause.link.skills_pinned,
        linked_repositories: clause.link.linked_repositories,
      },
      {
        path: "create",
        proposed_name: name,
        proposed_slug: name === null ? null : proposedSlug(name),
        skills_enabled: false,
      },
    ],
  });
  if (!unknown.success || !interject.success) return undefined;
  const events = [
    record.recorder.sealCollectorEvent("repo.unknown", unknown.data, fields),
    record.recorder.sealCollectorEvent(
      "control.interject",
      interject.data,
      fields,
    ),
  ];
  record.control.interjection = {
    key,
    question,
    expiresAt,
    workspaceSlug: clause.workspace_slug,
    configVersion: clause.config_version,
  };
  return events;
}

/** What the agent is told when the question timed out. */
export const INTERJECTION_TIMED_OUT_TEXT =
  "Oxagen asked a person whether to bind this repository to a workspace, " +
  "and nobody answered in time. This session goes on without skills.";

/**
 * The host's own `deny` for a held question whose deadline has passed:
 * `control.answer` with source `timeout`, then `skills.resolved` with
 * nothing in scope. The hold is released. Undefined when nothing is held or
 * the deadline has not passed.
 */
export function expireInterjection(
  record: SessionRecord,
  now: number,
  fields: InterjectionFrameFields,
): TachoEvent[] | undefined {
  const held = record.control.interjection;
  if (held === undefined || Date.parse(held.expiresAt) > now) return undefined;
  return settle(
    record,
    held,
    { path: "deny", source: "timeout" },
    undefined,
    fields,
  );
}

/**
 * The answer a `message` command carries, or undefined when it carries none
 * or one this host cannot read. A command without it, or with one a newer
 * control plane shaped differently, is delivered as plain text, as a host
 * built before #3941 delivers it.
 */
export function interjectionAnswerOf(
  payload: Record<string, unknown>,
): InterjectionAnswerPayload | undefined {
  const parsed = interjectionAnswerPayloadSchema.safeParse(
    payload["interjection"],
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Settle the held question with an answer from the control plane. Answers
 * the frames sealed, or undefined when the session holds no question under
 * the answer's key, in which case nothing is sealed.
 */
export function applyInterjectionAnswer(
  record: SessionRecord,
  answer: InterjectionAnswerPayload,
  commandId: string,
  fields: InterjectionFrameFields = {},
): TachoEvent[] | undefined {
  const held = record.control.interjection;
  if (held === undefined || held.key !== answer.key) return undefined;
  return settle(
    record,
    held,
    {
      path: answer.path,
      source: answer.source,
      receipt_id: answer.receipt_id,
      ...(answer.answered_by !== null
        ? { answered_by: answer.answered_by }
        : {}),
      ...(/^tcm_[0-9a-z]+$/.test(commandId) ? { command_id: commandId } : {}),
    },
    answer,
    fields,
  );
}

/**
 * Seal `control.answer` and the frames that record what the answer did, and
 * release the hold. A link records `repo.bound` when the answer names the
 * binding. A create records `workspace.created` and `repo.bound` when the
 * answer names them, then `skills.resolved` with nothing in scope, because a
 * new workspace starts with skills off. A deny records `skills.resolved` with
 * nothing in scope. After a link the workspace's configuration applies, and
 * the skill resolver seals its own `skills.resolved` (#3098).
 */
function settle(
  record: SessionRecord,
  held: HeldInterjection,
  answer: AnswerFields,
  payload: InterjectionAnswerPayload | undefined,
  fields: InterjectionFrameFields,
): TachoEvent[] | undefined {
  const key = held.key;
  const bodies: Array<[TachoKind, Record<string, unknown>]> = [];
  const answerBody = answerBodySchema.safeParse({
    interjection_key: key,
    ...answer,
  });
  if (!answerBody.success) return undefined;
  bodies.push(["control.answer", answerBody.data]);
  const bound = (role: "linked" | "main", slug: string | undefined) =>
    payload?.binding_id !== undefined && slug !== undefined
      ? repoBoundBodySchema.safeParse({
          interjection_key: key,
          binding_id: payload.binding_id,
          workspace_slug: slug,
          role,
        })
      : undefined;
  const nothingInScope = (
    reason: "skills_off" | "denied",
    configVersion: string | null,
  ) =>
    skillsResolvedBodySchema.safeParse({
      interjection_key: key,
      config_version: configVersion,
      in_scope: 0,
      withheld: null,
      reason,
    });
  if (answer.path === "link") {
    const slug = payload?.workspace_slug ?? held.workspaceSlug;
    const linked = bound("linked", slug);
    if (linked?.success) bodies.push(["repo.bound", linked.data]);
  } else if (answer.path === "create") {
    if (
      payload?.workspace_id !== undefined &&
      payload.workspace_slug !== undefined
    ) {
      const created = workspaceCreatedBodySchema.safeParse({
        interjection_key: key,
        workspace_id: payload.workspace_id,
        workspace_slug: payload.workspace_slug,
        skills_enabled: false,
      });
      if (created.success) bodies.push(["workspace.created", created.data]);
    }
    const main = bound("main", payload?.workspace_slug);
    if (main?.success) bodies.push(["repo.bound", main.data]);
    const resolved = nothingInScope("skills_off", null);
    if (resolved.success) bodies.push(["skills.resolved", resolved.data]);
  } else {
    const resolved = nothingInScope("denied", held.configVersion);
    if (resolved.success) bodies.push(["skills.resolved", resolved.data]);
  }
  const events = bodies.map(([kind, body]) =>
    record.recorder.sealCollectorEvent(kind, body, fields),
  );
  record.control.interjection = undefined;
  return events;
}
