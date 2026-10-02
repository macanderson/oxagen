// repository.steering-pr.test.ts: the steering PR that changes which code
// repositories workspace.toml lists (ADR-212). The host is a fake, so each
// test pins which host calls the module makes, in which order, and with
// which arguments.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { steeringPullRequestSchema } from "@oxagen/oxagen/contracts/repository.link";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { describe, expect, it, vi } from "vitest";
import type { SteeringRepository } from "./context.steering.github";
import { MemoryStore } from "./context.steering.test-support";
import {
  openSteeringPullRequest,
  type SteeringPullRequestHost,
  workspaceTomlBranch,
} from "./repository.steering-pr";

/**
 * The workspace's steering repository. Its production branch is not `main`,
 * so a base of `production` can only have come from here.
 */
const STEERING: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "production",
};

const BRANCH = "workspace/link-acme-docs-a9799a26";
const PR_URL = "https://github.com/acme/steering/pull/12";

const ARGS = {
  branch: BRANCH,
  content: "the new workspace.toml\n",
  message: "Link github.com/acme/docs",
  title: "Link acme/docs to the workspace",
  body: "This steering PR adds github.com/acme/docs to workspace.toml.",
};

/** A host that has no open steering PR and opens number 12. */
function host() {
  return {
    ensureBranch: vi.fn<SteeringPullRequestHost["ensureBranch"]>(
      async () => undefined,
    ),
    putFile: vi.fn<SteeringPullRequestHost["putFile"]>(async () => ({
      commitSha: "c0ffee",
    })),
    findOpenPullRequest: vi.fn<SteeringPullRequestHost["findOpenPullRequest"]>(
      async () => null,
    ),
    openPullRequest: vi.fn<SteeringPullRequestHost["openPullRequest"]>(
      async () => ({ number: 12, htmlUrl: PR_URL }),
    ),
  };
}

type HostFake = ReturnType<typeof host>;

/** When `fn` was first called, across every mock in the test. */
function firstCall(fn: { mock: { invocationCallOrder: number[] } }): number {
  const at = fn.mock.invocationCallOrder[0];
  if (at === undefined) throw new Error("the mock was not called");
  return at;
}

/** The HandlerError `call` rejects with. The test fails when it resolves. */
async function refusal(call: Promise<unknown>): Promise<HandlerError> {
  const err = await call.then(
    () => {
      throw new Error("expected the steering PR to be refused");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HandlerError);
  return err as HandlerError;
}

function expectNotCalled(...fns: HostFake[keyof HostFake][]): void {
  for (const fn of fns) expect(fn).not.toHaveBeenCalled();
}

describe("openSteeringPullRequest", () => {
  it("creates the branch from the production branch with no other options", async () => {
    const h = host();
    await openSteeringPullRequest(h, STEERING, ARGS);
    expect(h.ensureBranch.mock.calls).toEqual([
      [STEERING, BRANCH, "production"],
    ]);
    expect(h.ensureBranch.mock.calls[0]).toHaveLength(3);
  });

  it("writes workspace.toml on the branch", async () => {
    const h = host();
    await openSteeringPullRequest(h, STEERING, ARGS);
    expect(h.putFile.mock.calls).toEqual([
      [
        STEERING,
        {
          path: WORKSPACE_TOML_PATH,
          content: ARGS.content,
          message: ARGS.message,
          branch: BRANCH,
        },
      ],
    ]);
  });

  it("looks for an open steering PR from the branch into the production branch", async () => {
    const h = host();
    await openSteeringPullRequest(h, STEERING, ARGS);
    expect(h.findOpenPullRequest.mock.calls).toEqual([
      [STEERING, { head: BRANCH, base: "production" }],
    ]);
  });

  it("creates the branch, then writes the file, then looks for a steering PR, then opens one", async () => {
    const h = host();
    await openSteeringPullRequest(h, STEERING, ARGS);
    expect(firstCall(h.ensureBranch)).toBeLessThan(firstCall(h.putFile));
    expect(firstCall(h.putFile)).toBeLessThan(firstCall(h.findOpenPullRequest));
    expect(firstCall(h.findOpenPullRequest)).toBeLessThan(
      firstCall(h.openPullRequest),
    );
  });

  it("opens a steering PR with the Oxagen labels when none is open", async () => {
    const h = host();
    const result = await openSteeringPullRequest(h, STEERING, ARGS);
    expect(h.openPullRequest.mock.calls).toEqual([
      [
        STEERING,
        {
          title: ARGS.title,
          head: BRANCH,
          base: "production",
          body: ARGS.body,
          labels: OXAGEN_PR_LABELS,
        },
      ],
    ]);
    expect(h.openPullRequest.mock.calls[0]?.[1].labels).toBe(OXAGEN_PR_LABELS);
    expect(result).toEqual({ number: 12, url: PR_URL, reused: false });
    expect(steeringPullRequestSchema.parse(result)).toEqual(result);
  });

  it("reuses an open steering PR and opens no other", async () => {
    const h = host();
    const openUrl = "https://github.com/acme/steering/pull/7";
    h.findOpenPullRequest.mockResolvedValueOnce({
      number: 7,
      htmlUrl: openUrl,
      body: "An earlier link steering PR.",
    });
    const result = await openSteeringPullRequest(h, STEERING, ARGS);
    expect(result).toEqual({ number: 7, url: openUrl, reused: true });
    expect(steeringPullRequestSchema.parse(result)).toEqual(result);
    expect(h.openPullRequest).not.toHaveBeenCalled();
    // The file still lands on the branch, so the reused PR carries this change.
    expect(h.putFile).toHaveBeenCalledTimes(1);
  });

  describe("when the host refuses", () => {
    it("maps an ensureBranch refusal to conflict github_refused and runs no later step", async () => {
      const h = host();
      h.ensureBranch.mockRejectedValueOnce(new Error("Reference is protected"));
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("github_refused");
      expect(err.message).toBe("Reference is protected");
      expectNotCalled(h.putFile, h.findOpenPullRequest, h.openPullRequest);
    });

    it("maps a putFile refusal to conflict github_refused and runs no later step", async () => {
      const h = host();
      h.putFile.mockRejectedValueOnce(new Error("sha does not match"));
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("github_refused");
      expect(err.message).toBe("sha does not match");
      expectNotCalled(h.findOpenPullRequest, h.openPullRequest);
    });

    it("maps a findOpenPullRequest refusal to conflict github_refused and opens no steering PR", async () => {
      const h = host();
      h.findOpenPullRequest.mockRejectedValueOnce(new Error("Bad credentials"));
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("github_refused");
      expect(err.message).toBe("Bad credentials");
      expectNotCalled(h.openPullRequest);
    });

    it("maps an openPullRequest refusal to conflict github_refused", async () => {
      const h = host();
      h.openPullRequest.mockRejectedValueOnce(
        new Error("Validation Failed: no commits between production and the branch"),
      );
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("github_refused");
      expect(err.message).toBe(
        "Validation Failed: no commits between production and the branch",
      );
    });

    it("passes a HandlerError from the host through as the same error", async () => {
      const h = host();
      const shaped = new HandlerError({
        code: "conflict",
        reason: "proposal_branch_exists",
        message: "The branch already exists.",
      });
      h.putFile.mockRejectedValueOnce(shaped);
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err).toBe(shaped);
      expect(err.reason).toBe("proposal_branch_exists");
      expectNotCalled(h.findOpenPullRequest, h.openPullRequest);
    });

    it("uses a rejection that is not an Error as the message", async () => {
      const h = host();
      h.ensureBranch.mockRejectedValueOnce("rate limited");
      const err = await refusal(openSteeringPullRequest(h, STEERING, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("github_refused");
      expect(err.message).toBe("rate limited");
      expectNotCalled(h.putFile, h.findOpenPullRequest, h.openPullRequest);
    });
  });
});

describe("workspaceTomlBranch", () => {
  it("puts a link and an unlink on different branches under workspace/", () => {
    expect(workspaceTomlBranch("link", "acme", "docs")).toBe(
      "workspace/link-acme-docs-a9799a26",
    );
    expect(workspaceTomlBranch("unlink", "acme", "docs")).toBe(
      "workspace/unlink-acme-docs-a9799a26",
    );
  });

  it("lowercases the owner and the name", () => {
    expect(workspaceTomlBranch("link", "Acme", "Docs")).toBe(
      "workspace/link-acme-docs-a9799a26",
    );
  });

  it("keeps dots, underscores, and hyphens", () => {
    expect(workspaceTomlBranch("link", "a-intel", "platform_api.js")).toBe(
      "workspace/link-a-intel-platform_api.js-ad352b1a",
    );
  });

  it("replaces each run of other characters with one hyphen", () => {
    expect(workspaceTomlBranch("link", "Acme Corp", "My Repo!!")).toBe(
      "workspace/link-acme-corp-my-repo--b5aa3987",
    );
  });

  it("replaces the slash of a nested owner, so the branch has one level under workspace/", () => {
    expect(workspaceTomlBranch("link", "acme/platform", "api")).toBe(
      "workspace/link-acme-platform-api-2e58fef7",
    );
  });

  it("gives two repositories with the same readable part different branches", () => {
    expect(workspaceTomlBranch("link", "acme-corp", "docs")).toBe(
      "workspace/link-acme-corp-docs-2965c6c2",
    );
    expect(workspaceTomlBranch("link", "acme", "corp-docs")).toBe(
      "workspace/link-acme-corp-docs-a54566df",
    );
  });

  it("gives a ref git accepts for a name with dots", () => {
    // git refuses a ref with `..`, or one that ends in `.` or `.lock`.
    expect(workspaceTomlBranch("link", "acme", "a..b")).toBe(
      "workspace/link-acme-a.b-9d2eccf6",
    );
    expect(workspaceTomlBranch("link", "acme", "yarn.lock")).toBe(
      "workspace/link-acme-yarn.lock-ddc02fbc",
    );
    expect(workspaceTomlBranch("link", "acme", "end.")).toBe(
      "workspace/link-acme-end.-f0ff8c60",
    );
  });
});

describe("openSteeringPullRequest: the proposal row (#5122)", () => {
  const SCOPE = {
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  };
  const PERSON = "0192d4a8-7c1e-7a00-8000-0000000005e1";
  const record = (store: MemoryStore) => ({
    store,
    scope: SCOPE,
    author: { userId: PERSON, source: `user:${PERSON}` },
    now: new Date("2026-10-02T12:00:00.000Z"),
  });

  it("writes a workspace proposal for the PR it opens", async () => {
    const h = host();
    const store = new MemoryStore();
    await openSteeringPullRequest(h, STEERING, ARGS, record(store));

    expect(store.proposals).toHaveLength(1);
    expect(store.proposals[0]).toMatchObject({
      kind: "workspace",
      lineageId: BRANCH,
      status: "pr_open",
      branch: BRANCH,
      path: ".",
      prNumber: 12,
      prUrl: PR_URL,
      headSha: "c0ffee",
      baseRef: "production",
      createdById: PERSON,
      checks: [],
    });
  });

  it("moves the row of a reused PR to the commit this call wrote", async () => {
    const store = new MemoryStore();
    await openSteeringPullRequest(host(), STEERING, ARGS, record(store));
    const reused = host();
    reused.findOpenPullRequest.mockResolvedValue({
      number: 12,
      htmlUrl: PR_URL,
      body: "",
    });
    reused.putFile.mockResolvedValue({ commitSha: "d00d1e" });

    await openSteeringPullRequest(reused, STEERING, ARGS, record(store));

    expect(store.proposals).toHaveLength(1);
    expect(store.proposals[0]).toMatchObject({ prNumber: 12, headSha: "d00d1e" });
  });

  it("writes no row without a store", async () => {
    const h = host();
    const out = await openSteeringPullRequest(h, STEERING, ARGS);
    expect(out).toEqual({ number: 12, url: PR_URL, reused: false });
  });
});
