/**
 * resolve-target.test.ts — unit tests for the GitHub Setup URL path resolver.
 *
 * Covers:
 *   (a) buildSourcesPath — URL format.
 *   (b) Installation match → most recently installed workspace (row 0) wins;
 *       the fallback query is NOT consulted.
 *   (c) Multiple matches → picks row 0 (the "most recent first" contract the
 *       SQL `ORDER BY updated_at DESC` upholds).
 *   (d) installation_id present but no match → falls back to most recent membership.
 *   (e) No installation_id → match query is skipped entirely; fallback used.
 *   (f) Defensive: match row with null workspaceSlug → falls back.
 *   (g) Fallback with org + workspace → sources path.
 *   (h) Fallback org with no workspace → org root path.
 *   (i) No membership at all → /new-organization.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildSettingsGithubPath,
  buildSourcesPath,
  resolveGithubSetupTarget,
  type GithubSetupQueries,
  type GithubSetupTargetRow,
} from "./resolve-target";

function makeQueries(overrides: {
  match?: GithubSetupTargetRow[];
  membership?: GithubSetupTargetRow[];
}): {
  queries: GithubSetupQueries;
  matchInstallation: ReturnType<typeof vi.fn>;
  mostRecentMembership: ReturnType<typeof vi.fn>;
} {
  const matchInstallation = vi.fn(async () => overrides.match ?? []);
  const mostRecentMembership = vi.fn(async () => overrides.membership ?? []);
  return {
    queries: { matchInstallation, mostRecentMembership },
    matchInstallation,
    mostRecentMembership,
  };
}

describe("buildSourcesPath", () => {
  it("builds the repos connections URL with the github setup marker", () => {
    expect(buildSourcesPath("acme", "research")).toBe(
      "/acme/research/knowledge/sources?setup=github",
    );
  });
});

describe("buildSettingsGithubPath", () => {
  it("builds the settings/github URL (the connect/attach surface)", () => {
    expect(buildSettingsGithubPath("acme", "research")).toBe(
      "/acme/research/settings/github?github_installed=1",
    );
  });
});

describe("resolveGithubSetupTarget", () => {
  it("(b) lands on the most recently installed workspace and skips the fallback", async () => {
    const { queries, matchInstallation, mostRecentMembership } = makeQueries({
      match: [{ orgSlug: "acme", workspaceSlug: "research" }],
    });

    const target = await resolveGithubSetupTarget("user-1", "12345", queries);

    expect(target).toBe("/acme/research/knowledge/sources?setup=github");
    expect(matchInstallation).toHaveBeenCalledWith("user-1", "12345");
    expect(mostRecentMembership).not.toHaveBeenCalled();
  });

  it("(c) picks row 0 when the installation backs many tenants/workspaces", async () => {
    // The query returns most-recent-first; the resolver must take the first.
    const { queries } = makeQueries({
      match: [
        { orgSlug: "newest-tenant", workspaceSlug: "ws-new" },
        { orgSlug: "older-tenant", workspaceSlug: "ws-old" },
      ],
    });

    const target = await resolveGithubSetupTarget("user-1", "12345", queries);

    expect(target).toBe("/newest-tenant/ws-new/knowledge/sources?setup=github");
  });

  it("(d) falls back to most recent membership when no connection matches", async () => {
    const { queries, mostRecentMembership } = makeQueries({
      match: [],
      membership: [{ orgSlug: "acme", workspaceSlug: "research" }],
    });

    const target = await resolveGithubSetupTarget("user-1", "12345", queries);

    // No matching connection → land on the connect/attach surface (settings),
    // not the repo picker (which would assume a token and dead-end).
    expect(target).toBe("/acme/research/settings/github?github_installed=1");
    expect(mostRecentMembership).toHaveBeenCalledWith("user-1");
  });

  it("(e) skips the installation query entirely when no installation_id is given", async () => {
    const { queries, matchInstallation } = makeQueries({
      membership: [{ orgSlug: "acme", workspaceSlug: "research" }],
    });

    const target = await resolveGithubSetupTarget("user-1", undefined, queries);

    expect(target).toBe("/acme/research/settings/github?github_installed=1");
    expect(matchInstallation).not.toHaveBeenCalled();
  });

  it("(f) falls back when the match row has no workspace slug", async () => {
    const { queries, mostRecentMembership } = makeQueries({
      match: [{ orgSlug: "acme", workspaceSlug: null }],
      membership: [{ orgSlug: "acme", workspaceSlug: "research" }],
    });

    const target = await resolveGithubSetupTarget("user-1", "12345", queries);

    expect(target).toBe("/acme/research/settings/github?github_installed=1");
    expect(mostRecentMembership).toHaveBeenCalledTimes(1);
  });

  it("(g) uses the fallback workspace settings/github path", async () => {
    const { queries } = makeQueries({
      membership: [{ orgSlug: "beta", workspaceSlug: "main" }],
    });

    const target = await resolveGithubSetupTarget("user-1", undefined, queries);

    expect(target).toBe("/beta/main/settings/github?github_installed=1");
  });

  it("(h) sends the user to the org root when their org has no workspace yet", async () => {
    const { queries } = makeQueries({
      membership: [{ orgSlug: "beta", workspaceSlug: null }],
    });

    const target = await resolveGithubSetupTarget("user-1", undefined, queries);

    expect(target).toBe("/beta");
  });

  it("(i) sends the user to onboarding when they have no membership", async () => {
    const { queries } = makeQueries({ match: [], membership: [] });

    const target = await resolveGithubSetupTarget("user-1", "12345", queries);

    expect(target).toBe("/new-organization");
  });
});
