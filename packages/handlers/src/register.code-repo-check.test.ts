// Loading the handler registrations installs the runner the code repository
// check job calls (S2b, #5058). @oxagen/inngest-functions cannot import the
// check itself: this package depends on it.
import {
  codeRepoCheckRunner,
  type CodeRepoCheckRequest,
} from "@oxagen/inngest-functions/code-repo-check-runner";
import { getScope } from "@oxagen/tenancy";
import { describe, expect, it, vi } from "vitest";

const { runCheck } = vi.hoisted(() => ({ runCheck: vi.fn() }));
vi.mock("./code-repo-check/run", () => ({ runCodeRepoCheck: runCheck }));
vi.mock("./code-repo-check/deps", () => ({
  codeRepoCheckDeps: { tag: "production-deps" },
}));

await import("./register");

const request: CodeRepoCheckRequest = {
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
};

describe("the handler registrations", () => {
  it("run the code repository check with the production deps inside the workspace's tenant scope", async () => {
    let seen: unknown = null;
    runCheck.mockImplementation(async () => {
      seen = getScope();
      return { conclusion: "success", files: 0, findings: 0, memories: 0 };
    });
    await expect(codeRepoCheckRunner()(request)).resolves.toEqual({
      conclusion: "success",
      files: 0,
      findings: 0,
      memories: 0,
    });
    expect(runCheck).toHaveBeenCalledWith({ tag: "production-deps" }, request);
    expect(seen).toMatchObject({
      orgId: request.orgId,
      workspaceId: request.workspaceId,
    });
  });
});
