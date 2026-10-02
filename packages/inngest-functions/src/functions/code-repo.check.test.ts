// The code repository check job (S2b, #5058). The runner is the seam
// `@oxagen/handlers` installs at boot, so these tests install a fake one and
// assert what it receives, how the job is configured, and which events it
// refuses.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  CODE_REPO_CHECK_REQUESTED_EVENT,
  setCodeRepoCheckRunner,
  type CodeRepoCheckOutcome,
  type CodeRepoCheckRequest,
} from "../lib/code-repo-check-runner";
import { codeRepoCheck, codeRepoCheckRequestOf } from "./code-repo.check";

const GITHUB_REQUEST: CodeRepoCheckRequest = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  provider: "github",
  repositoryId: "771020341",
  fullName: "a-intel/platform",
  number: 318,
  url: "https://github.com/a-intel/platform/pull/318",
  headSha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
  base: "1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5",
  installationId: 61200044,
  connectionId: null,
  key: "0192d4a8-7c1e-7a00-8000-0000000c0e01:github:771020341:318",
  closed: null,
  mergeCommitSha: null,
};

const GITLAB_REQUEST: CodeRepoCheckRequest = {
  ...GITHUB_REQUEST,
  provider: "gitlab",
  repositoryId: "4242",
  fullName: "acme/platform/api",
  url: "https://gitlab.com/acme/platform/api/-/merge_requests/7",
  base: "main",
  installationId: null,
  connectionId: "0192d4a8-7c1e-7a00-8000-00000000c011",
  key: "0192d4a8-7c1e-7a00-8000-0000000c0e01:gitlab:4242:7",
  number: 7,
};

type Handler = (ctx: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

const job = codeRepoCheck as unknown as Handler;

function fakeStep() {
  const names: string[] = [];
  return {
    names,
    run: async (name: string, fn: () => unknown) => {
      names.push(name);
      return fn();
    },
  };
}

async function failureOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("The run finished, and the test expected it to fail.");
}

describe("code-repo/check", () => {
  it("runs on code-repo/check.requested, one check at a time per pull request", () => {
    const config = mocks.configs.find(
      (c) => (c.options as { id: string }).id === "code-repo/check",
    );
    expect(config).toEqual({
      options: {
        id: "code-repo/check",
        retries: 3,
        concurrency: { limit: 1, key: "event.data.key" },
      },
      trigger: { event: CODE_REPO_CHECK_REQUESTED_EVENT },
    });
  });

  it("hands the event's request to the runner in one step and returns its outcome", async () => {
    const outcome: CodeRepoCheckOutcome = {
      conclusion: "neutral",
      files: 1,
      findings: 2,
      memories: 1,
    };
    const runner = vi.fn(async () => outcome);
    setCodeRepoCheckRunner(runner);
    const step = fakeStep();
    await expect(
      job({ event: { data: { ...GITHUB_REQUEST } }, step }),
    ).resolves.toEqual(outcome);
    expect(step.names).toEqual(["check"]);
    expect(runner).toHaveBeenCalledWith(GITHUB_REQUEST);
  });

  it("refuses without a retry an event that names no pull request", async () => {
    const runner = vi.fn();
    setCodeRepoCheckRunner(runner);
    const data: Record<string, unknown> = { ...GITHUB_REQUEST };
    delete data.number;
    const err = await failureOf(job({ event: { data }, step: fakeStep() }));
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("lets a runner error throw, so Inngest retries the check", async () => {
    setCodeRepoCheckRunner(async () => {
      throw new Error("GitHub API error 502");
    });
    const err = await failureOf(
      job({ event: { data: { ...GITHUB_REQUEST } }, step: fakeStep() }),
    );
    expect((err as Error).message).toBe("GitHub API error 502");
  });
});

describe("codeRepoCheckRequestOf", () => {
  it("reads a GitHub request and a GitLab request", () => {
    expect(codeRepoCheckRequestOf(GITHUB_REQUEST)).toEqual(GITHUB_REQUEST);
    expect(codeRepoCheckRequestOf(GITLAB_REQUEST)).toEqual(GITLAB_REQUEST);
  });

  it("refuses a GitHub request with no installation and a GitLab request with no connection", () => {
    expect(
      codeRepoCheckRequestOf({ ...GITHUB_REQUEST, installationId: null }),
    ).toBeNull();
    expect(
      codeRepoCheckRequestOf({ ...GITLAB_REQUEST, connectionId: null }),
    ).toBeNull();
  });

  it("reads a closed pull request, and an event sent before closes were routed as a check (ADR-254)", () => {
    const merged = {
      ...GITHUB_REQUEST,
      closed: "merged" as const,
      mergeCommitSha: "5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918",
    };
    expect(codeRepoCheckRequestOf(merged)).toEqual(merged);
    expect(
      codeRepoCheckRequestOf({ ...GITHUB_REQUEST, closed: "unmerged" }),
    ).toEqual({ ...GITHUB_REQUEST, closed: "unmerged" });
    const older: Record<string, unknown> = { ...GITHUB_REQUEST };
    delete older.closed;
    delete older.mergeCommitSha;
    expect(codeRepoCheckRequestOf(older)).toEqual(GITHUB_REQUEST);
    // An unknown close reads as a check, never as a deletion.
    expect(
      codeRepoCheckRequestOf({ ...GITHUB_REQUEST, closed: "abandoned" }),
    ).toEqual(GITHUB_REQUEST);
  });

  it("refuses an unknown host, a missing head, and a pull request number that is not a whole number", () => {
    expect(
      codeRepoCheckRequestOf({ ...GITHUB_REQUEST, provider: "bitbucket" }),
    ).toBeNull();
    expect(codeRepoCheckRequestOf({ ...GITHUB_REQUEST, headSha: "" })).toBeNull();
    expect(codeRepoCheckRequestOf({ ...GITHUB_REQUEST, number: 1.5 })).toBeNull();
    expect(codeRepoCheckRequestOf(null)).toBeNull();
  });
});
