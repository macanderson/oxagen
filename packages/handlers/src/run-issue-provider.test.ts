import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  installation: vi.fn(),
  token: vi.fn(),
  linearToken: vi.fn(),
  linear: vi.fn(),
}));
vi.mock("@oxagen/plugins/run-outcomes-policy", () => ({
  assertRunOutcomesAllowed: mocks.guard,
}));
vi.mock("@oxagen/github", () => ({ getInstallationToken: mocks.token }));
vi.mock("./repository.github-connection", () => ({
  resolveWorkspaceGithubInstallation: mocks.installation,
}));
vi.mock("@oxagen/plugins/run-outcomes-linear", () => ({
  linearGraphql: mocks.linear,
  resolveLinearIssueToken: mocks.linearToken,
}));
import {
  createRunIssue,
  linearIssueId,
  readRunRepositoryStyle,
} from "./run-issue-provider";
const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const destination = {
  provider: "github" as const,
  owner: "acme",
  repo: "control",
};
const marker = "a".repeat(64);
const request = {
  destination,
  marker,
  title: "Repair the recorded failure",
  body: "Evidence from the recorded diff",
  allowCreate: true,
};
const issue = {
  id: 19,
  number: 7,
  html_url: "https://github.com/acme/control/issues/7",
  body: `<!-- oxagen-run-outcome:${marker} -->`,
};
const empty = { incomplete_results: false, total_count: 0, items: [] };
let fetchMock: ReturnType<typeof vi.fn>;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_APP_ID", "app");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
  mocks.guard.mockResolvedValue(undefined);
  mocks.installation.mockResolvedValue({
    installationId: "123",
    status: "connected",
  });
  mocks.token.mockResolvedValue({ token: "short-lived" });
  mocks.linearToken.mockResolvedValue("linear-token");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("native issue receipts", () => {
  it("creates a selected GitHub issue with a repository-scoped grant and real receipt", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({ full_name: "acme/control", has_issues: true }),
      )
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response(issue));
    expect(await createRunIssue(scope, request)).toMatchObject({
      provider: "github",
      identifier: "#7",
      url: issue.html_url,
    });
    expect(mocks.installation).toHaveBeenCalledWith(scope);
    expect(mocks.token).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "123",
        repositories: ["control"],
        permissions: { issues: "write", contents: "read", metadata: "read" },
      }),
    );
    const post = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "POST",
    );
    expect(JSON.parse(post?.[1].body)).toEqual({
      title: request.title,
      body: `${request.body}\n\n<!-- oxagen-run-outcome:${marker} -->`,
    });
    expect(
      fetchMock.mock.calls.every((call) => call[1].redirect === "error"),
    ).toBe(true);
  });
  it("reconciles a timed out POST without issuing a second write", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({ full_name: "acme/control", has_issues: true }),
      )
      .mockResolvedValueOnce(response(empty))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(
        response({ incomplete_results: false, total_count: 1, items: [issue] }),
      );
    expect(await createRunIssue(scope, request)).toMatchObject({
      issueId: "19",
    });
    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });
  it("never treats an empty eventually consistent search as permission to retry a write", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({ full_name: "acme/control", has_issues: true }),
      )
      .mockResolvedValueOnce(response(empty));
    await expect(
      createRunIssue(scope, { ...request, allowCreate: false }),
    ).rejects.toMatchObject({ reason: "run_issue_creation_unconfirmed" });
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
  });
  it("refuses suspended policy before the next provider request", async () => {
    fetchMock.mockImplementation(async () => {
      mocks.guard.mockRejectedValue(new Error("disabled"));
      return response({ full_name: "acme/control", has_issues: true });
    });
    await expect(createRunIssue(scope, request)).rejects.toThrow("disabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("refuses paused GitHub connections before minting credentials", async () => {
    mocks.installation.mockResolvedValue({
      installationId: "123",
      status: "paused",
    });
    await expect(createRunIssue(scope, request)).rejects.toMatchObject({
      reason: "github_not_connected",
    });
    expect(mocks.token).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a receipt for another repository", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({ full_name: "acme/control", has_issues: true }),
      )
      .mockResolvedValueOnce(
        response({
          incomplete_results: false,
          total_count: 1,
          items: [
            { ...issue, html_url: "https://github.com/other/repo/issues/7" },
          ],
        }),
      );
    await expect(createRunIssue(scope, request)).rejects.toMatchObject({
      reason: "github_issue_receipt_mismatch",
    });
  });
  it("keeps Linear issue UUIDs stable within the scope and distinct across tenants", () => {
    const d = {
      provider: "linear" as const,
      connectionId: "con_1",
      teamId: scope.orgId,
    };
    expect(linearIssueId(scope, d, marker)).toMatch(
      /^[0-9a-f-]{14}4[0-9a-f-]{21}$/,
    );
    expect(linearIssueId(scope, d, marker)).toBe(
      linearIssueId(scope, d, marker),
    );
    expect(
      linearIssueId({ ...scope, orgId: scope.workspaceId }, d, marker),
    ).not.toBe(linearIssueId(scope, d, marker));
  });
  it("creates Linear with the verified team and deterministic UUID, then returns its real link", async () => {
    const d = {
      provider: "linear" as const,
      connectionId: "con_1",
      teamId: scope.orgId,
    };
    const id = linearIssueId(scope, d, marker);
    const receipt = {
      id,
      identifier: "OPS-9",
      url: "https://linear.app/acme/issue/OPS-9/repair",
      description: issue.body,
      team: { id: d.teamId },
      project: null,
    };
    mocks.linear
      .mockResolvedValueOnce({ team: { id: d.teamId } })
      .mockResolvedValueOnce({ issues: { nodes: [] } })
      .mockResolvedValueOnce({
        issueCreate: { success: true, issue: receipt },
      });
    expect(
      await createRunIssue(scope, { ...request, destination: d }),
    ).toMatchObject({ identifier: "OPS-9", url: receipt.url });
    expect(mocks.linearToken).toHaveBeenCalledWith(scope, "con_1");
    expect(mocks.linear.mock.calls[2]?.[3]).toMatchObject({
      input: { id, teamId: d.teamId },
    });
  });
  it("reads style only at an immutable commit and reports absent files", async () => {
    fetchMock.mockResolvedValue(response({}, 404));
    const style = await readRunRepositoryStyle(scope, {
      owner: "acme",
      repo: "control",
      ref: "b".repeat(40),
    });
    expect(style.files).toEqual([]);
    expect(style.missing).toContain("AGENTS.md");
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call[0]).endsWith(`ref=${"b".repeat(40)}`),
      ),
    ).toBe(true);
    expect(mocks.token).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { contents: "read", metadata: "read" },
      }),
    );
    await expect(
      readRunRepositoryStyle(scope, {
        owner: "acme",
        repo: "control",
        ref: "main",
      }),
    ).rejects.toMatchObject({ reason: "repository_style_requires_commit" });
  });
});
