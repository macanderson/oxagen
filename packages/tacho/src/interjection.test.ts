// The bodies of the unbound-repository frames (#3941): each round-trips, and
// each refuses a member it does not name, so drift between the host that
// seals a body and the ingest that reads it fails loudly.
import { describe, expect, it } from "vitest";
import {
  answerBodySchema,
  interjectBodySchema,
  interjectionAnswerPayloadSchema,
  repoBoundBodySchema,
  repoUnknownBodySchema,
  skillsResolvedBodySchema,
  workspaceCreatedBodySchema,
} from "./interjection";

const KEY = "01K6Z000000000000000000000";
const DIGEST = `sha256:${"e".repeat(64)}`;

const BODIES = {
  "repo.unknown": [
    repoUnknownBodySchema,
    {
      remote_digest: DIGEST,
      remote_digest_folded: DIGEST,
      head_sha: "a".repeat(40),
      skills_enabled: true,
      unbound_repo: "ask",
      config_version: "skl_v2",
    },
  ],
  "control.interject": [
    interjectBodySchema,
    {
      interjection_key: KEY,
      reason: "repo_unknown",
      question: "Link this repository to core, or create a workspace for it?",
      remote_digest: DIGEST,
      timeout_ms: 1_800_000,
      expires_at: "2026-09-26T10:30:00.000Z",
      on_timeout: "deny",
      paths: [
        {
          path: "link",
          workspace_slug: "core",
          config_version: null,
          skills_pinned: null,
          linked_repositories: 0,
        },
        {
          path: "create",
          proposed_name: null,
          proposed_slug: null,
          skills_enabled: false,
        },
      ],
    },
  ],
  "control.answer": [
    answerBodySchema,
    {
      interjection_key: KEY,
      interjection_id: "inj_0123abc",
      path: "create",
      source: "person",
      receipt_id: "rcp_0123abc",
      answered_by: "usr_0123abc",
      command_id: "tcm_0123abc",
    },
  ],
  "repo.bound": [
    repoBoundBodySchema,
    {
      interjection_key: KEY,
      binding_id: "rpb_1",
      workspace_slug: "core",
      role: "linked",
    },
  ],
  "workspace.created": [
    workspaceCreatedBodySchema,
    {
      interjection_key: KEY,
      workspace_id: "wrk_1",
      workspace_slug: "payments",
      skills_enabled: false,
    },
  ],
  "skills.resolved": [
    skillsResolvedBodySchema,
    {
      config_version: null,
      in_scope: 0,
      withheld: null,
      reason: "denied",
    },
  ],
} as const;

describe("the unbound-repository frame bodies", () => {
  it.each(Object.entries(BODIES))("%s round-trips", (_kind, [schema, body]) => {
    expect(schema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });

  it.each(Object.entries(BODIES))(
    "%s refuses a member it does not name (negative)",
    (_kind, [schema, body]) => {
      expect(schema.safeParse({ ...body, drifted: 1 }).success).toBe(false);
    },
  );

  it("holds the question to the repository reason, a deny timeout and link before create", () => {
    const [, question] = BODIES["control.interject"];
    expect(
      interjectBodySchema.safeParse({ ...question, reason: "curious" }).success,
    ).toBe(false);
    expect(
      interjectBodySchema.safeParse({ ...question, on_timeout: "link" })
        .success,
    ).toBe(false);
    expect(
      interjectBodySchema.safeParse({
        ...question,
        paths: [...question.paths].reverse(),
      }).success,
    ).toBe(false);
    expect(
      interjectBodySchema.safeParse({
        ...question,
        interjection_key: "not-a-ulid",
      }).success,
    ).toBe(false);
  });

  it("refuses a receipt, a person or a command in another form (negative)", () => {
    const [, answer] = BODIES["control.answer"];
    for (const drift of [
      { receipt_id: "receipt-1" },
      { answered_by: "user_1" },
      { command_id: "cmd_1" },
      { path: "maybe" },
    ])
      expect(answerBodySchema.safeParse({ ...answer, ...drift }).success).toBe(
        false,
      );
  });

  it("carries an answer to the host in a message payload, with no person on a timeout", () => {
    const payload = {
      key: KEY,
      path: "deny",
      source: "timeout",
      receipt_id: "rcp_0123abc",
      answered_by: null,
    };
    expect(interjectionAnswerPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      interjectionAnswerPayloadSchema.safeParse({ ...payload, text: "hi" })
        .success,
    ).toBe(false);
  });
});
