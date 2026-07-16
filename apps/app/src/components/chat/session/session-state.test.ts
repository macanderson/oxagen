import { describe, it, expect } from "vitest";
import {
  applyCodeBinding,
  applyCodeMemory,
  applySessionPatch,
  agentMemoryKey,
  codeMemoryOf,
  computeSessionLocks,
  decodeCodeMemory,
  decodeSessionState,
  defaultChatSessionState,
  encodeCodeMemory,
  encodeSessionState,
  ownerOfRepoKey,
  seedSessionState,
  sessionDiffersFromDefaults,
  sessionSelectionIssues,
  sessionStorageKey,
  sessionSubtitleParts,
  type ChatSessionState,
  type SessionSeed,
} from "./session-state";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

const REPOS: RepoOption[] = [
  {
    key: "con_1::acme/platform",
    connectionId: "con_1",
    owner: "acme",
    name: "platform",
    defaultBranch: "main",
  },
  {
    key: "con_1::acme/site",
    connectionId: "con_1",
    owner: "acme",
    name: "site",
    defaultBranch: "development",
  },
  {
    key: "con_2::umbrella/labs",
    connectionId: "con_2",
    owner: "umbrella",
    name: "labs",
    defaultBranch: "main",
  },
];

const ENVS: EnvironmentOption[] = [
  { id: "env_1", name: "Node 22", isDefault: true },
  { id: "env_2", name: "Python", isDefault: false },
];

const SEED: SessionSeed = {
  defaultAgentId: "agt_default",
  defaultRepoKey: "con_1::acme/platform",
  defaultEnvId: "env_1",
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

const BINDING: StoredCodeBinding = {
  version: 1,
  agentId: "agt_code",
  connectionId: "con_1",
  owner: "acme",
  name: "platform",
  defaultBranch: "main",
  environmentId: "env_1",
  environmentName: "Node 22",
};

function base(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return { ...defaultChatSessionState, ...overrides };
}

describe("ownerOfRepoKey", () => {
  it("extracts the owner from a connection-scoped key", () => {
    expect(ownerOfRepoKey("con_1::acme/platform")).toBe("acme");
  });
  it("returns null for null or malformed keys", () => {
    expect(ownerOfRepoKey(null)).toBeNull();
    expect(ownerOfRepoKey("no-separator")).toBeNull();
    expect(ownerOfRepoKey("con_1::noslash")).toBeNull();
  });
});

describe("applySessionPatch cascades", () => {
  it("changing org resets repo and branch", () => {
    const state = base({
      org: "acme",
      repoKey: "con_1::acme/platform",
      branch: "feat/x",
    });
    const next = applySessionPatch(state, { org: "umbrella" });
    expect(next.org).toBe("umbrella");
    expect(next.repoKey).toBeNull();
    expect(next.branch).toBeNull();
  });

  it("changing repo resets branch to default and re-derives org", () => {
    const state = base({
      org: "acme",
      repoKey: "con_1::acme/platform",
      branch: "feat/x",
    });
    const next = applySessionPatch(state, { repoKey: "con_2::umbrella/labs" });
    expect(next.repoKey).toBe("con_2::umbrella/labs");
    expect(next.branch).toBeNull();
    expect(next.org).toBe("umbrella");
  });

  it("setting the same org does not clear the repo", () => {
    const state = base({ org: "acme", repoKey: "con_1::acme/platform" });
    const next = applySessionPatch(state, { org: "acme" });
    expect(next.repoKey).toBe("con_1::acme/platform");
  });

  it("an explicit model clears tier, and vice versa", () => {
    const withModel = applySessionPatch(base({ tier: "fast" }), {
      model: "anthropic/claude-sonnet-5",
    });
    expect(withModel.tier).toBeNull();
    const withTier = applySessionPatch(withModel, { tier: "precise" });
    expect(withTier.model).toBeNull();
  });

  it("branch can be set explicitly alongside a repo change", () => {
    const next = applySessionPatch(base(), {
      repoKey: "con_1::acme/site",
      branch: "release",
    });
    expect(next.branch).toBe("release");
  });
});

describe("seedSessionState", () => {
  it("seeds from workspace defaults including derived org", () => {
    const seeded = seedSessionState(SEED);
    expect(seeded.agentId).toBe("agt_default");
    expect(seeded.repoKey).toBe("con_1::acme/platform");
    expect(seeded.org).toBe("acme");
    expect(seeded.envId).toBe("env_1");
    expect(seeded.branch).toBeNull();
    expect(seeded.tier).toBe("fast");
  });

  it("prefers an explicit default model over the tier", () => {
    const seeded = seedSessionState({
      ...SEED,
      textModel: "anthropic/claude-sonnet-5",
    });
    expect(seeded.model).toBe("anthropic/claude-sonnet-5");
    expect(seeded.tier).toBeNull();
  });
});

describe("agent code memory", () => {
  it("round-trips through the codec and applies with cascades", () => {
    const state = base({
      org: "acme",
      repoKey: "con_1::acme/site",
      branch: "development",
      envId: "env_2",
    });
    const memory = decodeCodeMemory(encodeCodeMemory(codeMemoryOf(state)));
    expect(memory).toEqual({
      org: "acme",
      repoKey: "con_1::acme/site",
      branch: "development",
      envId: "env_2",
    });
    const applied = applyCodeMemory(base(), memory);
    expect(applied.repoKey).toBe("con_1::acme/site");
    expect(applied.branch).toBe("development");
    expect(applied.envId).toBe("env_2");
  });

  it("null memory leaves the state untouched", () => {
    const state = base({ repoKey: "con_1::acme/platform" });
    expect(applyCodeMemory(state, null)).toBe(state);
  });

  it("decode tolerates corrupt payloads", () => {
    expect(decodeCodeMemory("not json")).toBeNull();
    expect(decodeCodeMemory(null)).toBeNull();
    expect(decodeCodeMemory("42")).toBeNull();
  });
});

describe("applyCodeBinding", () => {
  it("forces agent, org, repo, and env onto the binding", () => {
    const drifted = base({
      agentId: "agt_other",
      org: "umbrella",
      repoKey: "con_2::umbrella/labs",
      branch: "feat/y",
      envId: "env_2",
    });
    const pinned = applyCodeBinding(drifted, BINDING);
    expect(pinned.agentId).toBe("agt_code");
    expect(pinned.org).toBe("acme");
    expect(pinned.repoKey).toBe("con_1::acme/platform");
    expect(pinned.envId).toBe("env_1");
    // Branch resets because the repo changed under it.
    expect(pinned.branch).toBeNull();
  });

  it("keeps an explicit branch when the repo already matches the binding", () => {
    const state = base({
      repoKey: "con_1::acme/platform",
      branch: "feat/keep-me",
    });
    const pinned = applyCodeBinding(state, BINDING);
    expect(pinned.branch).toBe("feat/keep-me");
  });

  it("null binding is a no-op", () => {
    const state = base({ agentId: "agt_x" });
    expect(applyCodeBinding(state, null)).toBe(state);
  });
});

describe("computeSessionLocks", () => {
  it("locks the agent after the first message", () => {
    expect(
      computeSessionLocks({
        hasMessages: true,
        codeBinding: null,
        clientLocked: false,
      }),
    ).toEqual({ agent: true, code: false });
  });
  it("locks agent and code once a binding exists", () => {
    expect(
      computeSessionLocks({
        hasMessages: false,
        codeBinding: BINDING,
        clientLocked: false,
      }),
    ).toEqual({ agent: true, code: true });
  });
  it("client lock covers the send→revalidate gap", () => {
    expect(
      computeSessionLocks({
        hasMessages: false,
        codeBinding: null,
        clientLocked: true,
      }),
    ).toEqual({ agent: true, code: true });
  });
  it("a brand-new chat is fully unlocked", () => {
    expect(
      computeSessionLocks({
        hasMessages: false,
        codeBinding: null,
        clientLocked: false,
      }),
    ).toEqual({ agent: false, code: false });
  });
});

describe("sessionSelectionIssues", () => {
  it("flags a repo that no longer resolves", () => {
    const issues = sessionSelectionIssues(
      base({ repoKey: "con_9::gone/repo" }),
      {
        repos: REPOS,
        environments: ENVS,
        branches: null,
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("repo");
  });

  it("flags a deleted branch only when the branch list is loaded", () => {
    const state = base({ repoKey: "con_1::acme/platform", branch: "feat/x" });
    expect(
      sessionSelectionIssues(state, {
        repos: REPOS,
        environments: ENVS,
        branches: null,
      }),
    ).toHaveLength(0);
    const issues = sessionSelectionIssues(state, {
      repos: REPOS,
      environments: ENVS,
      branches: ["main", "development"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("branch");
    expect(issues[0]?.message).toBe(
      "Branch feat/x was deleted. Pick another branch.",
    );
  });

  it("flags a removed environment", () => {
    const issues = sessionSelectionIssues(base({ envId: "env_gone" }), {
      repos: REPOS,
      environments: ENVS,
      branches: null,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("environment");
  });

  it("a clean selection yields no issues", () => {
    const state = base({
      repoKey: "con_1::acme/platform",
      branch: "main",
      envId: "env_1",
    });
    expect(
      sessionSelectionIssues(state, {
        repos: REPOS,
        environments: ENVS,
        branches: ["main"],
      }),
    ).toHaveLength(0);
  });
});

describe("sessionDiffersFromDefaults", () => {
  const defaults = seedSessionState(SEED);
  it("false when identical", () => {
    expect(sessionDiffersFromDefaults({ ...defaults }, defaults)).toBe(false);
  });
  it("true on any changed field", () => {
    expect(
      sessionDiffersFromDefaults({ ...defaults, effort: "high" }, defaults),
    ).toBe(true);
    expect(
      sessionDiffersFromDefaults({ ...defaults, budgetUsd: 2 }, defaults),
    ).toBe(true);
  });
});

describe("sessionSubtitleParts", () => {
  it("resolves repo slug, explicit branch, and env name", () => {
    const parts = sessionSubtitleParts(
      base({ repoKey: "con_1::acme/site", branch: "feat/x", envId: "env_2" }),
      { repos: REPOS, environments: ENVS, modelLabel: "Sonnet" },
    );
    expect(parts).toEqual({
      model: "Sonnet",
      repo: "acme/site",
      branch: "feat/x",
      environment: "Python",
    });
  });

  it("falls back to the repo default branch when none is chosen — the single source the header and panel both read", () => {
    const parts = sessionSubtitleParts(
      base({ repoKey: "con_1::acme/site", branch: null }),
      { repos: REPOS, environments: ENVS, modelLabel: "Fast" },
    );
    expect(parts.branch).toBe("development");
  });

  it("degrades to nulls without a repo/env", () => {
    const parts = sessionSubtitleParts(base(), {
      repos: REPOS,
      environments: ENVS,
      modelLabel: "Fast",
    });
    expect(parts.repo).toBeNull();
    expect(parts.branch).toBeNull();
    expect(parts.environment).toBeNull();
  });
});

describe("persistence codecs", () => {
  it("round-trips a full state", () => {
    const state = base({
      agentId: "agt_1",
      tier: null,
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      budgetUsd: 2,
      org: "acme",
      repoKey: "con_1::acme/platform",
      branch: "feat/x",
      envId: "env_1",
    });
    expect(
      decodeSessionState(encodeSessionState(state), defaultChatSessionState),
    ).toEqual(state);
  });

  it("rejects wrong versions and corrupt JSON", () => {
    expect(decodeSessionState(null, defaultChatSessionState)).toBeNull();
    expect(decodeSessionState("not json", defaultChatSessionState)).toBeNull();
    expect(
      decodeSessionState(
        JSON.stringify({ v: 99, agentId: "x" }),
        defaultChatSessionState,
      ),
    ).toBeNull();
  });

  it("sanitizes invalid fields to the base instead of discarding the rest", () => {
    const decoded = decodeSessionState(
      JSON.stringify({
        v: 1,
        agentId: "agt_1",
        tier: "warp-speed",
        effort: "impossible",
        budgetUsd: -4,
      }),
      defaultChatSessionState,
    );
    expect(decoded?.agentId).toBe("agt_1");
    expect(decoded?.tier).toBe(defaultChatSessionState.tier);
    expect(decoded?.effort).toBe(defaultChatSessionState.effort);
    expect(decoded?.budgetUsd).toBeNull();
  });
});

describe("storage keys", () => {
  it("scopes conversation, draft, and agent-memory keys", () => {
    expect(sessionStorageKey("ws", "cnv_1")).toBe(
      "oxagen:chat-session:v1:conv:cnv_1",
    );
    expect(sessionStorageKey("ws", null)).toBe(
      "oxagen:chat-session:v1:draft:ws",
    );
    expect(sessionStorageKey(undefined, null)).toBe(
      "oxagen:chat-session:v1:draft:_",
    );
    expect(agentMemoryKey("ws", "agt_1")).toBe(
      "oxagen:chat-session:v1:agent:ws:agt_1",
    );
  });
});
