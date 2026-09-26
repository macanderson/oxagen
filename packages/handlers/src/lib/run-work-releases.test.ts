import type { GitHubRelease } from "@oxagen/github";
import { describe, expect, it, vi } from "vitest";
import type { CommandRefFrameRow } from "./run-command-refs";
import type { ConnectedRunRepository } from "./run-work";
import { readWorkReleases } from "./run-work-releases";

const scope = {
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
};
const acme: ConnectedRunRepository = {
  connectionId: "conn_1",
  providerRepositoryId: "R_1",
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};

function frame(seq: number, command: string): CommandRefFrameRow {
  return {
    seq,
    command,
    path: "/work/app",
    observed_at: "2026-09-26 10:00:00.000",
    issue_repository: "",
    issue_number: "",
    issue_url: "",
    issue_action: "",
  };
}

function release(tagName: string): GitHubRelease {
  return {
    tagName,
    name: tagName,
    htmlUrl: `https://github.com/acme/app/releases/tag/${tagName}`,
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-26T10:00:00Z",
  };
}

function over(listed: GitHubRelease[]) {
  const listReleases = vi.fn().mockResolvedValue(listed);
  const client = vi.fn(async () => ({ listReleases }));
  return { listReleases, client, deps: { client } };
}

describe("readWorkReleases (#3890)", () => {
  it("reads each repository's releases once, however many of its tags the session created", async () => {
    const github = over([release("v1"), release("v2")]);
    const result = await readWorkReleases(
      scope,
      [
        frame(1, "gh release create v1 -R acme/app"),
        frame(2, "gh release create v2 -R acme/app"),
      ],
      [],
      [acme],
      github.deps,
    );
    expect(result.releases.map(({ tag, state }) => [tag, state])).toEqual([
      ["v1", "published"],
      ["v2", "published"],
    ]);
    expect(result.warnings).toEqual([]);
    expect(github.listReleases).toHaveBeenCalledOnce();
    // Read through the repository's own connection.
    expect(github.client).toHaveBeenCalledWith(scope, acme);
  });

  it("does not call a tag GitHub did not list missing when the list was a full page (negative)", async () => {
    const page = Array.from({ length: 100 }, (_, i) => release(`v0.${String(i)}`));
    const result = await readWorkReleases(
      scope,
      [frame(1, "gh release create v9 -R acme/app")],
      [],
      [acme],
      over(page).deps,
    );
    expect(result.releases[0]?.state).toBeNull();
    expect(result.warnings).toEqual(["release_list_limit"]);
  });

  it("stops at 20 releases and says so", async () => {
    const frames = Array.from({ length: 21 }, (_, i) =>
      frame(i, `gh release create v${String(i)} -R acme/app`),
    );
    const result = await readWorkReleases(
      scope,
      frames,
      [],
      [acme],
      over([]).deps,
    );
    expect(result.releases).toHaveLength(20);
    expect(result.warnings).toContain("release_limit");
  });

  it("says the frame read was cut short at its cap", async () => {
    const frames = Array.from({ length: 2001 }, (_, i) => frame(i, "git status"));
    const result = await readWorkReleases(
      scope,
      frames,
      [],
      [acme],
      over([]).deps,
    );
    expect(result.warnings).toEqual(["release_frame_limit"]);
  });
});
