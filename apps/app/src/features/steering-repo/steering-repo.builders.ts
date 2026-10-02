// Test builders for the steering repo lane (#4518): one steering repo view in
// each state the card, the provisioning list, and the health banner draw.
// Every builder starts from a repo that finished provisioning and reads
// healthy, and a test overrides only what it is about. `steeringRepoSource`
// is a DataSource that answers the lane's one read, `get_steering_repo`.
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import {
  type SettingsDifferenceView,
  STEERING_REPO_STEPS,
  type SteeringRepoStep,
  type SteeringRepoView,
} from "./types";

export const GITHUB_REPOSITORY = {
  fullName: "acme/oxagen-core-platform",
  url: "https://github.com/acme/oxagen-core-platform",
};

export const GITLAB_REPOSITORY = {
  fullName: "acme/steering/oxagen-core-platform",
  url: "https://gitlab.com/acme/steering/oxagen-core-platform",
};

/** A steering repo that finished provisioning on GitHub and reads healthy. */
export function steeringRepoView(
  overrides: Partial<SteeringRepoView> = {},
): SteeringRepoView {
  return {
    status: "ready",
    step: "bind_repository",
    failedStep: null,
    error: null,
    provider: "github",
    repository: GITHUB_REPOSITORY,
    publishedVersion: 3,
    health: "healthy",
    differences: [],
    legacySource: null,
    connection: null,
    connectionChoices: [],
    ...overrides,
  };
}

/** A code repository that still steers a workspace made before steering repos. */
export const LEGACY_SOURCE = {
  fullName: "acme/agent-harness",
  url: "https://github.com/acme/agent-harness",
  provider: "github" as const,
};

/**
 * A workspace that never recorded a setup (#4875): every provisioning field
 * null. Pass `legacySource` for one whose old main repository still steers it.
 */
export function notStartedSteeringRepo(
  overrides: Partial<SteeringRepoView> = {},
): SteeringRepoView {
  return steeringRepoView({
    status: "not_started",
    step: null,
    failedStep: null,
    error: null,
    provider: null,
    repository: null,
    publishedVersion: null,
    health: null,
    ...overrides,
  });
}

/**
 * A steering repo whose job failed at `failedStep` with `error`, after every
 * step before it finished. It has no repository, version, or health yet.
 */
export function failedSteeringRepo(
  failedStep: SteeringRepoStep,
  error: { code: string; message: string },
  overrides: Partial<SteeringRepoView> = {},
): SteeringRepoView {
  return steeringRepoView({
    status: "failed",
    step:
      STEERING_REPO_STEPS[STEERING_REPO_STEPS.indexOf(failedStep) - 1] ?? null,
    failedStep,
    error,
    repository: null,
    publishedVersion: null,
    health: null,
    ...overrides,
  });
}

/** One prescribed setting that differs, changed by a named person. */
export function settingsDifference(
  overrides: Partial<SettingsDifferenceView> = {},
): SettingsDifferenceView {
  return {
    setting: "rulesets.oxagen_merges",
    expected: "active",
    actual: "disabled",
    changedBy: "jordan-lee",
    changedAt: "2026-09-26T14:05:00.000Z",
    ...overrides,
  };
}

/**
 * A DataSource that answers `steeringRepo.get` with `read` and refuses every
 * other port, so a test that reaches for another read fails rather than
 * passing on a stub. `calls` records the arguments of each steering repo read.
 */
export function steeringRepoSource(read: Read<SteeringRepoView>) {
  const calls: unknown[][] = [];
  const refuse = () => Promise.reject(new Error("not a steering repo read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    conversations: { latest: refuse, list: refuse, byId: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      commands: refuse,
      outputs: refuse,
      work: refuse,
      issues: refuse,
      context: refuse,
      findings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse, forRun: refuse },
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      operatorRanking: refuse,
      perMergedPr: refuse,
      unpricedModels: refuse,
      unproductive: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      slackConnection: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      layout: refuse,
      hub: refuse,
      workspaceMemories: refuse,
      workspaceMemory: refuse,
      memoryPrRecords: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    steeringRepo: {
      get: (...args) => {
        calls.push(args);
        // The contract's record holds mutable arrays, and the view's are
        // read-only, so an answered read copies them across.
        return Promise.resolve(
          read.ok
            ? readOk({
                ...read.value,
                differences: [...read.value.differences],
                connectionChoices: [...read.value.connectionChoices],
              })
            : read,
        );
      },
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
      toolbelts: refuse,
      toolbelt: refuse,
    },
    mandates: { list: refuse, get: refuse },
  };
  return { source, calls };
}
