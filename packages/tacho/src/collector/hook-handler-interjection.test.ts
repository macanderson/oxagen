/**
 * The repository question (#3941): a session that starts in a repository the
 * organisation has not bound, on a host whose bundle carries `unbound_repo`,
 * is held at its first prompt, before any model call, until a person answers
 * or the timeout answers `deny`.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { digestBytes } from "../digest";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import {
  answerBodySchema,
  interjectBodySchema,
  repoBoundBodySchema,
  repoUnknownBodySchema,
  skillsResolvedBodySchema,
  workspaceCreatedBodySchema,
} from "../interjection";
import { canonicalRemote, foldedRemote } from "../remote";
import type {
  CommandAcknowledgement,
  DeliveredCommand,
  PolicyBundle,
  TachoHarness,
} from "../wire";
import type { RepositoryRemote } from "./git-facts";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { applyCommands } from "./inbox";
import {
  INTERJECTION_TIMED_OUT_TEXT,
  interjectionQuestion,
  proposedSlug,
} from "./interjection";
import { type RegistryState, SessionRegistry } from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const SESSION = "5b0f5c1e-7a2d-4c3b-9e8f-0a1b2c3d4e5f";
const TIMEOUT_MS = 30 * 60 * 1000;

/** The digests a host computes for a remote. */
function remoteOf(remote: string, name?: string): RepositoryRemote {
  const canonical = canonicalRemote(remote);
  return {
    remote_digest: digestBytes(canonical),
    remote_digest_folded: digestBytes(foldedRemote(canonical)),
    ...(name !== undefined ? { name } : {}),
    head_sha: "a".repeat(40),
  };
}

const PAYMENTS = remoteOf("git@github.com:acme/payments.git", "payments");
const BOUND = remoteOf("git@github.com:acme/core.git", "core");

const UNBOUND_REPO: NonNullable<PolicyBundle["unbound_repo"]> = {
  policy: "ask",
  timeout_ms: TIMEOUT_MS,
  workspace_slug: "core",
  config_version: "skl_v2",
  bound_remote_digests: [BOUND.remote_digest, BOUND.remote_digest_folded],
  link: { skills_pinned: 3, linked_repositories: 1 },
};

function harness(
  options: {
    bundle?: Partial<Omit<PolicyBundle, "signature">>;
    verified?: boolean;
    remote?: RepositoryRemote | undefined;
  } = {},
) {
  const bundle = bundleSigner().sign(
    unsignedBundle({ unbound_repo: UNBOUND_REPO, ...options.bundle }),
  );
  let clock = Date.parse("2026-09-26T10:00:00.000Z");
  const now = () => (clock += 1000);
  const advance = (ms: number) => {
    clock += ms;
  };
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const view: PolicyView = {
    bundle,
    verified: options.verified ?? true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
  };
  const acks: CommandAcknowledgement[] = [];
  const remote = vi.fn(async (_cwd: string) =>
    "remote" in options ? options.remote : PAYMENTS,
  );
  const deps = {
    registry,
    policy: () => view,
    acknowledge: (ack: CommandAcknowledgement) => acks.push(ack),
    now,
    repositoryRemote: remote,
  };
  return { registry, deps, acks, now, advance, remote };
}

type Harness = ReturnType<typeof harness>;

function hook(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION,
    cwd: "/home/dev/payments",
    hook_event_name,
    ...extra,
  };
}

async function start(h: Harness, agentHarness?: TachoHarness) {
  const outcome = await handleHookEvent(
    hook("SessionStart", { source: "startup" }),
    {},
    h.deps,
    undefined,
    agentHarness,
  );
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return { record, events: outcome.events };
}

function prompt(
  h: Harness,
  text = "fix the flaky test",
  agentHarness?: TachoHarness,
) {
  return handleHookEvent(
    hook("UserPromptSubmit", { prompt: text }),
    {},
    h.deps,
    undefined,
    agentHarness,
  );
}

const kinds = (events: readonly TachoEvent[]) => events.map((e) => e.kind);
/** The frames about the repository question among `events`, in order. */
const QUESTION_KINDS: ReadonlySet<string> = new Set([
  "repo.unknown",
  "control.interject",
  "control.answer",
  "repo.bound",
  "workspace.created",
  "skills.resolved",
]);
const asked = (events: readonly TachoEvent[]) =>
  kinds(events).filter((kind) => QUESTION_KINDS.has(kind));
const bodyOf = (events: readonly TachoEvent[], kind: string) =>
  events.find((e) => e.kind === kind)?.body as Record<string, unknown>;

describe("the question at the first prompt", () => {
  it("seals repo.unknown and control.interject after agent_start and before any model call, and refuses the prompt", async () => {
    const h = harness();
    const { events: opening } = await start(h);
    expect(kinds(opening)).toContain("agent_start");
    const first = await prompt(h);
    expect(kinds(first.events)).toEqual([
      "repo.unknown",
      "control.interject",
      "turn_start",
    ]);
    expect(kinds([...opening, ...first.events])).not.toContain("llm_call");
    const all = [...opening, ...first.events];
    expect(all.findIndex((e) => e.kind === "agent_start")).toBeLessThan(
      all.findIndex((e) => e.kind === "repo.unknown"),
    );

    const unknown = repoUnknownBodySchema.parse(
      bodyOf(first.events, "repo.unknown"),
    );
    expect(unknown).toMatchObject({
      remote_digest: PAYMENTS.remote_digest,
      remote_digest_folded: PAYMENTS.remote_digest_folded,
      skills_enabled: true,
      unbound_repo: "ask",
      config_version: "skl_v2",
    });

    const interject = interjectBodySchema.parse(
      bodyOf(first.events, "control.interject"),
    );
    expect(interject.question).toBe(interjectionQuestion(UNBOUND_REPO));
    expect(interject).toMatchObject({
      reason: "repo_unknown",
      timeout_ms: TIMEOUT_MS,
      on_timeout: "deny",
      paths: [
        {
          path: "link",
          workspace_slug: "core",
          config_version: "skl_v2",
          skills_pinned: 3,
          linked_repositories: 1,
        },
        {
          path: "create",
          proposed_name: "payments",
          proposed_slug: "payments",
          skills_enabled: false,
        },
      ],
    });
    // The host's clock at the prompt plus the bundle's timeout.
    const wait =
      Date.parse(interject.expires_at) - Date.parse("2026-09-26T10:00:00.000Z");
    expect(wait).toBeGreaterThan(TIMEOUT_MS);
    expect(wait).toBeLessThan(TIMEOUT_MS + 60_000);

    // The harness shows the question as the reason the prompt was refused.
    expect(first.response).toEqual({
      decision: "block",
      reason: interject.question,
    });
    expect(bodyOf(first.events, "turn_start")).toMatchObject({
      policy_decision: "deny",
      policy_reason_code: "interjection_open",
    });
    expect(h.remote).toHaveBeenCalledWith("/home/dev/payments");
  });

  it("refuses every later prompt with the same question and seals no second one", async () => {
    const h = harness();
    await start(h);
    const first = await prompt(h);
    const again = await prompt(h, "please continue");
    expect(asked(again.events)).toEqual([]);
    expect(bodyOf(again.events, "turn_start")).toMatchObject({
      policy_decision: "deny",
      policy_reason_code: "interjection_open",
    });
    expect(again.response).toEqual(first.response);
    expect(h.remote).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a repository the organisation bound, by either digest", async () => {
    for (const remote of [
      BOUND,
      // Typed in another case: only the folded digest matches.
      remoteOf("git@github.com:ACME/Core.git", "Core"),
    ]) {
      const h = harness({ remote });
      await start(h);
      const first = await prompt(h);
      expect(kinds(first.events)).toEqual(["turn_start"]);
      expect(first.response).toEqual({});
    }
  });

  const QUIET: Array<[string, Parameters<typeof harness>[0]]> = [
    ["the workspace's skills are off", { bundle: { unbound_repo: undefined } }],
    ["the bundle did not verify", { verified: false }],
    ["the directory has no origin", { remote: undefined }],
  ];
  it.each(QUIET)("asks nothing when %s", async (_name, options) => {
    const h = harness(options);
    await start(h);
    const first = await prompt(h);
    expect(kinds(first.events)).toEqual(["turn_start"]);
    expect(first.response).toEqual({});
    expect(h.registry.get(SESSION)?.control.interjection).toBeUndefined();
  });

  it("asks nothing once the chain has recorded a model call", async () => {
    const h = harness();
    const { record } = await start(h);
    record.recorder.sealCollectorEvent("llm_call", {
      model: "claude-test",
      request_id: "req_1",
      input_tokens: 10,
      output_tokens: 5,
    });
    const first = await prompt(h);
    expect(kinds(first.events)).toEqual(["turn_start"]);
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("asks nothing of Stella, which cannot show a refused prompt's reason", async () => {
    const h = harness();
    await start(h, "stella");
    const first = await prompt(h, "go", "stella");
    expect(kinds(first.events)).not.toContain("control.interject");
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("asks nothing for a replayed first prompt, which the harness already sent on", async () => {
    const h = harness();
    await start(h);
    const replayed = await handleHookEvent(
      hook("UserPromptSubmit", { prompt: "go" }),
      {},
      h.deps,
      { receivedAt: "2026-09-26T10:00:05.000Z" },
    );
    expect(kinds(replayed.events)).toEqual(["turn_start"]);
    // The check ran: a later live prompt asks nothing either.
    const later = await prompt(h);
    expect(asked(later.events)).toEqual([]);
    expect(later.response).toEqual({});
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("asks once per session, so a prompt after an allowed first one asks nothing", async () => {
    const h = harness({ remote: BOUND });
    await start(h);
    await prompt(h);
    h.remote.mockResolvedValue(PAYMENTS);
    const second = await prompt(h);
    expect(asked(second.events)).toEqual([]);
    expect(second.response).toEqual({});
    expect(h.remote).toHaveBeenCalledTimes(1);
  });

  it("keeps the question held across a daemon restart", async () => {
    const h = harness();
    await start(h);
    const first = await prompt(h);
    const state = JSON.parse(
      JSON.stringify(h.registry.state()),
    ) as RegistryState;
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: h.now,
    });
    restored.restore(state);
    const control = restored.get(SESSION)?.control;
    expect(control?.repoChecked).toBe(true);
    expect(control?.interjection?.question).toBe(
      interjectionQuestion(UNBOUND_REPO),
    );
    const after = await handleHookEvent(
      hook("UserPromptSubmit", { prompt: "go" }),
      {},
      { ...h.deps, registry: restored },
    );
    expect(asked(after.events)).toEqual([]);
    expect(after.response).toEqual(first.response);
  });
});

describe("the timeout", () => {
  it("answers deny on the host once the deadline passes, and lets the prompt through with the reason", async () => {
    const h = harness();
    await start(h);
    const first = await prompt(h);
    const key = interjectBodySchema.parse(
      bodyOf(first.events, "control.interject"),
    ).interjection_key;
    h.advance(TIMEOUT_MS);
    const after = await prompt(h, "still there?");
    // Settled ahead of the prompt it lets through.
    expect(asked(after.events)).toEqual(["control.answer", "skills.resolved"]);
    expect(kinds(after.events).at(-1)).toBe("turn_start");
    expect(
      answerBodySchema.parse(bodyOf(after.events, "control.answer")),
    ).toEqual({ interjection_key: key, path: "deny", source: "timeout" });
    expect(
      skillsResolvedBodySchema.parse(bodyOf(after.events, "skills.resolved")),
    ).toEqual({
      interjection_key: key,
      config_version: "skl_v2",
      in_scope: 0,
      withheld: null,
      reason: "denied",
    });
    expect(bodyOf(after.events, "turn_start")).toMatchObject({
      policy_decision: "allow",
    });
    expect(after.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: INTERJECTION_TIMED_OUT_TEXT,
      },
    });
    expect(h.registry.get(SESSION)?.control.interjection).toBeUndefined();
    // Settled once: the next prompt seals nothing more about it.
    const next = await prompt(h, "and now?");
    expect(asked(next.events)).toEqual([]);
    expect(next.response).toEqual({});
  });

  it("holds until the deadline, not a moment less (negative)", async () => {
    const h = harness();
    await start(h);
    await prompt(h);
    h.advance(TIMEOUT_MS - 60_000);
    const early = await prompt(h);
    expect(asked(early.events)).toEqual([]);
    expect(early.response).toMatchObject({ decision: "block" });
  });
});

function command(
  record: { recorder: { sessionUuid: string } },
  overrides: Partial<DeliveredCommand>,
): DeliveredCommand {
  return {
    id: "tcm_answer1",
    command: "message",
    session_uuid: record.recorder.sessionUuid,
    payload: {},
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-09-26T10:01:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

async function held(h: Harness) {
  const { record } = await start(h);
  const first = await prompt(h);
  const key = interjectBodySchema.parse(
    bodyOf(first.events, "control.interject"),
  ).interjection_key;
  return { record, key };
}

function deliver(
  h: Harness,
  record: Awaited<ReturnType<typeof held>>["record"],
  payload: Record<string, unknown>,
) {
  return applyCommands([command(record, { payload })], {
    registry: h.registry,
    hostRecorder: () => record.recorder,
    kill: () => true,
    refreshBundle: async () => undefined,
    onHostSuspended: () => undefined,
    now: h.now,
  });
}

describe("an answer from the control plane", () => {
  it("settles a link: control.answer, then repo.bound, and prompts go through", async () => {
    const h = harness();
    const { record, key } = await held(h);
    const result = await deliver(h, record, {
      text: "Oxagen linked this repository to core.",
      interjection: {
        key,
        path: "link",
        source: "person",
        receipt_id: "rcp_01a2b3",
        answered_by: "usr_0123abc",
        binding_id: "rpb_77",
        workspace_slug: "core",
      },
    });
    expect(kinds(result.events)).toEqual(["control.answer", "repo.bound"]);
    expect(
      answerBodySchema.parse(bodyOf(result.events, "control.answer")),
    ).toEqual({
      interjection_key: key,
      path: "link",
      source: "person",
      receipt_id: "rcp_01a2b3",
      answered_by: "usr_0123abc",
      command_id: "tcm_answer1",
    });
    expect(
      repoBoundBodySchema.parse(bodyOf(result.events, "repo.bound")),
    ).toEqual({
      interjection_key: key,
      binding_id: "rpb_77",
      workspace_slug: "core",
      role: "linked",
    });
    expect(result.acknowledgements[0]?.status).toBe("received");
    expect(record.control.interjection).toBeUndefined();
    // The next prompt goes through, and carries the answer to the agent.
    const next = await prompt(h, "carry on");
    expect(next.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Oxagen linked this repository to core.",
      },
    });
  });

  it("settles a create: the workspace, its main binding, and no skills in scope", async () => {
    const h = harness();
    const { record, key } = await held(h);
    const result = await deliver(h, record, {
      text: "Oxagen made the workspace payments for this repository.",
      interjection: {
        key,
        path: "create",
        source: "person",
        receipt_id: "rcp_01a2b4",
        answered_by: "usr_0123abc",
        binding_id: "rpb_78",
        workspace_id: "wrk_payments",
        workspace_slug: "payments",
      },
    });
    expect(kinds(result.events)).toEqual([
      "control.answer",
      "workspace.created",
      "repo.bound",
      "skills.resolved",
    ]);
    expect(
      workspaceCreatedBodySchema.parse(
        bodyOf(result.events, "workspace.created"),
      ),
    ).toEqual({
      interjection_key: key,
      workspace_id: "wrk_payments",
      workspace_slug: "payments",
      skills_enabled: false,
    });
    expect(bodyOf(result.events, "repo.bound")).toMatchObject({
      role: "main",
      workspace_slug: "payments",
    });
    expect(
      skillsResolvedBodySchema.parse(bodyOf(result.events, "skills.resolved")),
    ).toMatchObject({ in_scope: 0, reason: "skills_off" });
    expect(record.control.interjection).toBeUndefined();
  });

  it("settles the control plane's timeout deny", async () => {
    const h = harness();
    const { record, key } = await held(h);
    const result = await deliver(h, record, {
      text: "Nobody answered in 30 minutes. This session runs without skills.",
      interjection: {
        key,
        path: "deny",
        source: "timeout",
        receipt_id: "rcp_01a2b5",
        answered_by: null,
      },
    });
    expect(kinds(result.events)).toEqual(["control.answer", "skills.resolved"]);
    expect(bodyOf(result.events, "control.answer")).not.toHaveProperty(
      "answered_by",
    );
    expect(bodyOf(result.events, "skills.resolved")).toMatchObject({
      reason: "denied",
      in_scope: 0,
    });
  });

  it("seals nothing and delivers nothing for an answer under another key (negative)", async () => {
    const h = harness();
    const { record } = await held(h);
    const result = await deliver(h, record, {
      text: "linked",
      interjection: {
        key: "01K6Z000000000000000000000",
        path: "link",
        source: "person",
        receipt_id: "rcp_01a2b6",
        answered_by: "usr_0123abc",
      },
    });
    expect(result.events).toEqual([]);
    expect(result.acknowledgements[0]?.status).toBe("failed");
    expect(record.control.interjection).toBeDefined();
    expect(record.control.messages).toEqual([]);
  });

  it("still queues a plain message that carries no answer, as before", async () => {
    const h = harness();
    const { record } = await held(h);
    const result = await deliver(h, record, { text: "hello" });
    expect(result.events).toEqual([]);
    expect(result.acknowledgements[0]?.status).toBe("received");
    expect(record.control.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(record.control.interjection).toBeDefined();
  });
});

describe("proposedSlug", () => {
  it.each([
    ["payments", "payments"],
    ["My_Repo.JS", "my-repo-js"],
    ["--edge--", "edge"],
    ["x".repeat(60), "x".repeat(40)],
    ["a", null],
    ["___", null],
  ])("%s becomes %s", (name, slug) => {
    expect(proposedSlug(name)).toBe(slug);
  });
});
