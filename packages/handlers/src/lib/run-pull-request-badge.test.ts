// The Oxagen block and label on a pull request a wrapped agent opened
// (#5059, ADR-252): where the block goes, how it is refreshed in place, and
// why a second pass writes nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getInstallationToken: vi.fn() }));
vi.mock("@oxagen/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/github")>();
  return { ...actual, getInstallationToken: mocks.getInstallationToken };
});

import { readManagedBlock } from "@oxagen/oxagen/steering-repo";
import {
  AGENT_PR_LABEL,
  AGENT_RUN_BADGE_URL,
  agentRunBlock,
  badgeInstallationToken,
  type BadgeClient,
  markRunPullRequest,
  runPageUrl,
  withAgentRunBlock,
} from "./run-pull-request-badge";

const RUN = "https://app.oxagen.sh/acme/core/runs/tse_01J9ZQ3";
const NEXT_RUN = "https://app.oxagen.sh/acme/core/runs/tse_01J9ZQ4";
const TARGET = { owner: "acme", repo: "api", number: 42 };

beforeEach(() => {
  mocks.getInstallationToken.mockReset();
});

describe("agentRunBlock", () => {
  it("links the badge to the run inside one intact managed block", () => {
    const block = agentRunBlock(RUN);
    expect(block).toContain(`[![oxagen: agent run](${AGENT_RUN_BADGE_URL})](${RUN})`);
    const read = readManagedBlock(block);
    expect(read.ok && read.block?.intact).toBe(true);
  });

  it("shows the badge alone when there is no run page to link", () => {
    const block = agentRunBlock(null);
    expect(block).toContain(`![oxagen: agent run](${AGENT_RUN_BADGE_URL})\n`);
    expect(block).not.toContain("](https://app");
  });
});

describe("withAgentRunBlock", () => {
  const block = agentRunBlock(RUN);

  it.each([
    ["no description", null],
    ["an empty description", ""],
    ["a blank description", "\n\n"],
  ])("makes the block the whole description for %s", (_label, body) => {
    expect(withAgentRunBlock(body, block)).toEqual({ change: "added", body: block });
  });

  it("puts the block at the top, above a blank line and the author's text", () => {
    const body = "## Summary\n\nFixes the retry budget.";
    expect(withAgentRunBlock(body, block)).toEqual({
      change: "added",
      body: `${block}\n${body}`,
    });
  });

  it("refreshes the block in place and keeps the text around it", () => {
    const before = "Intro the author wrote.\n\n";
    const after = "\n## Summary\n\nFixes the retry budget.";
    const body = `${before}${agentRunBlock(RUN)}${after}`;
    const edit = withAgentRunBlock(body, agentRunBlock(NEXT_RUN));
    expect(edit).toEqual({
      change: "refreshed",
      body: `${before}${agentRunBlock(NEXT_RUN)}${after}`,
    });
  });

  it("puts back a block someone edited by hand", () => {
    const edited = block.replace("agent run", "agent ran");
    expect(withAgentRunBlock(`${edited}\nText.`, block)).toEqual({
      change: "refreshed",
      body: `${block}\nText.`,
    });
  });

  it("reports no change when the block is already there", () => {
    const body = `${block}\nText.`;
    expect(withAgentRunBlock(body, block)).toEqual({ change: "unchanged", body });
  });

  it("reads a description GitHub's web form saved with CRLF line ends", () => {
    const body = `${block}\nText.`.replace(/\n/g, "\r\n");
    expect(withAgentRunBlock(body, block).change).toBe("unchanged");
  });

  it.each([
    ["a begin marker with no end", `${block.split("\n")[0]}\nText.`],
    ["two blocks", `${block}${block}`],
  ])("leaves a description with %s alone (negative)", (_label, body) => {
    expect(withAgentRunBlock(body, block)).toEqual({ change: "malformed", body });
  });
});

function fakeClient(pr: { body: string | null; labels: string[] }) {
  const calls = {
    getPullRequest: vi.fn(async () => ({ ...pr })),
    updatePullRequest: vi.fn(async () => ({ number: 42, htmlUrl: "u" })),
    createLabel: vi.fn(async () => "created" as const),
    addLabels: vi.fn(async () => [...pr.labels, AGENT_PR_LABEL]),
  };
  return { client: calls as unknown as BadgeClient, calls };
}

describe("markRunPullRequest", () => {
  it("adds the block and the label to a pull request that has neither", async () => {
    const { client, calls } = fakeClient({ body: "Fixes the retry budget.", labels: ["bug"] });
    expect(await markRunPullRequest(client, TARGET, RUN)).toEqual({
      block: "added",
      label: "added",
    });
    expect(calls.getPullRequest).toHaveBeenCalledWith(TARGET);
    // The body alone: no title, so a title changed since the read stays.
    expect(calls.updatePullRequest).toHaveBeenCalledWith({
      ...TARGET,
      body: `${agentRunBlock(RUN)}\nFixes the retry budget.`,
    });
    expect(calls.createLabel).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      name: "oxagen",
      color: "09090B",
      description: "Opened by an agent during a run Oxagen recorded",
    });
    expect(calls.addLabels).toHaveBeenCalledWith({ ...TARGET, labels: ["oxagen"] });
  });

  it("writes nothing the second time", async () => {
    const { client, calls } = fakeClient({
      body: `${agentRunBlock(RUN)}\nFixes the retry budget.`,
      labels: ["bug", "oxagen"],
    });
    expect(await markRunPullRequest(client, TARGET, RUN)).toEqual({
      block: "unchanged",
      label: "present",
    });
    expect(calls.updatePullRequest).not.toHaveBeenCalled();
    expect(calls.createLabel).not.toHaveBeenCalled();
    expect(calls.addLabels).not.toHaveBeenCalled();
  });

  it("refreshes the block in place and adds the label once", async () => {
    const { client, calls } = fakeClient({
      body: `${agentRunBlock(RUN)}\nText.`,
      labels: ["oxagen"],
    });
    expect(await markRunPullRequest(client, TARGET, NEXT_RUN)).toEqual({
      block: "refreshed",
      label: "present",
    });
    expect(calls.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(calls.updatePullRequest).toHaveBeenCalledWith({
      ...TARGET,
      body: `${agentRunBlock(NEXT_RUN)}\nText.`,
    });
    expect(calls.addLabels).not.toHaveBeenCalled();
  });

  it("counts the label in any case, as GitHub does", async () => {
    const { client, calls } = fakeClient({ body: null, labels: ["Oxagen"] });
    expect((await markRunPullRequest(client, TARGET, RUN)).label).toBe("present");
    expect(calls.createLabel).not.toHaveBeenCalled();
    expect(calls.addLabels).not.toHaveBeenCalled();
  });

  it("still labels a pull request whose block it cannot read (negative)", async () => {
    const broken = `${agentRunBlock(RUN).split("\n")[0]}\nText.`;
    const { client, calls } = fakeClient({ body: broken, labels: [] });
    expect(await markRunPullRequest(client, TARGET, RUN)).toEqual({
      block: "malformed",
      label: "added",
    });
    expect(calls.updatePullRequest).not.toHaveBeenCalled();
    expect(calls.addLabels).toHaveBeenCalledTimes(1);
  });
});

describe("runPageUrl", () => {
  it("builds the run page on the app origin", () => {
    expect(
      runPageUrl("https://app.oxagen.sh", {
        orgSlug: "acme",
        workspaceSlug: "core",
        runId: "tse_01J9ZQ3",
      }),
    ).toBe(RUN);
  });

  it("encodes each part of the path", () => {
    expect(
      runPageUrl("https://app.oxagen.sh/", {
        orgSlug: "a cme",
        workspaceSlug: "co/re",
        runId: "tse_1",
      }),
    ).toBe("https://app.oxagen.sh/a%20cme/co%2Fre/runs/tse_1");
  });

  it.each([undefined, "", "not a url"])(
    "answers null for the origin %j (negative)",
    (origin) => {
      expect(
        runPageUrl(origin, { orgSlug: "acme", workspaceSlug: "core", runId: "tse_1" }),
      ).toBeNull();
    },
  );
});

describe("badgeInstallationToken", () => {
  const ENV = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "pem" };

  it("throws a mint failure that is not a refusal", async () => {
    mocks.getInstallationToken.mockRejectedValue(
      new Error("GitHub App token mint failed (500): Internal Server Error"),
    );
    await expect(badgeInstallationToken("777", "api", ENV)).rejects.toThrow("(500)");
  });

  it("answers refused when the installation cannot reach the repository", async () => {
    mocks.getInstallationToken.mockRejectedValue(
      new Error("GitHub App token mint failed (404): Not Found"),
    );
    expect(await badgeInstallationToken("777", "api", ENV)).toBe("refused");
  });

  it("answers null when the deployment has no app settings", async () => {
    expect(await badgeInstallationToken("777", "api", {})).toBeNull();
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });
});
