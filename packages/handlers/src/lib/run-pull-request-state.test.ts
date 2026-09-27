import { describe, expect, it } from "vitest";
import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  applyForgeState,
  forgeKeyOf,
  githubForgeState,
  gitlabForgeState,
  insertRunPullRequest,
  storedStatesQuery,
  wireStateOf,
} from "./run-pull-request-state";

const db = drizzle.mock({ schema });
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const SESSION = "0192d4a8-7c1e-7a00-8000-0000000000a1";

describe("forgeKeyOf", () => {
  it("reads a GitHub pull request, repository lower-cased", () => {
    expect(forgeKeyOf("https://github.com/Acme/API/pull/42")).toEqual({
      provider: "github",
      repository: "acme/api",
      number: 42,
    });
  });

  it("reads a GitLab merge request under a nested group", () => {
    expect(
      forgeKeyOf("https://gitlab.com/Acme/Platform/api/-/merge_requests/9/"),
    ).toEqual({
      provider: "gitlab",
      repository: "acme/platform/api",
      number: 9,
    });
  });

  it.each([
    ["plain http", "http://github.com/acme/api/pull/42"],
    ["another host", "https://git.example.com/acme/api/pull/42"],
    ["an issue", "https://github.com/acme/api/issues/42"],
    ["a port", "https://github.com:8443/acme/api/pull/42"],
    ["credentials", "https://me:pw@github.com/acme/api/pull/42"],
    ["number zero", "https://github.com/acme/api/pull/0"],
    ["a number past int4", "https://github.com/acme/api/pull/2147483648"],
    [
      "a GitLab path with no group",
      "https://gitlab.com/api/-/merge_requests/9",
    ],
    ["not a URL", "#42"],
  ])("reads %s as no key (negative)", (_label, url) => {
    expect(forgeKeyOf(url)).toBeNull();
  });
});

describe("githubForgeState", () => {
  const at = "2026-09-25T10:00:00Z";

  it("reads merged over closed", () => {
    expect(
      githubForgeState({ state: "closed", merged: true, updated_at: at }),
    ).toEqual({
      state: "merged",
      draft: false,
      sourceUpdatedAt: new Date(at),
    });
  });

  it("keeps an open draft's flag and drops a closed one's", () => {
    expect(githubForgeState({ state: "open", draft: true })).toMatchObject({
      state: "open",
      draft: true,
      sourceUpdatedAt: null,
    });
    expect(githubForgeState({ state: "closed", draft: true })).toMatchObject({
      state: "closed",
      draft: false,
    });
  });

  it("reads the REST client's camel-case updatedAt", () => {
    expect(
      githubForgeState({ state: "open", draft: false, updatedAt: at })
        ?.sourceUpdatedAt,
    ).toEqual(new Date(at));
  });

  it.each([
    { state: "weird" },
    {},
    { state: "open", updated_at: "not a date" },
  ])("reads %o as no state or no date (negative)", (pr) => {
    const out = githubForgeState(pr);
    expect(out === null || out.sourceUpdatedAt === null).toBe(true);
  });
});

describe("gitlabForgeState", () => {
  it.each([
    ["opened", false, { state: "open", draft: false }],
    ["opened", true, { state: "open", draft: true }],
    ["locked", false, { state: "open", draft: false }],
    ["merged", true, { state: "merged", draft: false }],
    ["closed", true, { state: "closed", draft: false }],
  ] as const)("maps %s (draft %s)", (state, draft, want) => {
    expect(gitlabForgeState({ state, draft })).toMatchObject(want);
  });

  it("reads an undocumented state as none (negative)", () => {
    expect(gitlabForgeState({ state: "archived" })).toBeNull();
  });
});

describe("wireStateOf", () => {
  it.each([
    [{ state: "open", draft: false }, "open"],
    [{ state: "open", draft: true }, "draft"],
    [{ state: "merged", draft: false }, "merged"],
    [{ state: "closed", draft: false }, "closed"],
    [{ state: null, draft: false }, null],
    [{ state: "reopened", draft: false }, null],
  ] as const)("reads %o as %o", (row, want) => {
    expect(wireStateOf(row)).toBe(want);
  });
});

describe("the SQL", () => {
  it("reads a page's rows through the session's uuid, fenced to the tenant", () => {
    const { sql, params } = storedStatesQuery(db, SCOPE, [SESSION]).toSQL();
    expect(sql).toContain('from "tacho"."run_pull_requests"');
    expect(sql).toContain('inner join "tacho"."sessions"');
    expect(sql).toContain(
      '"tacho"."sessions"."id" = "tacho"."run_pull_requests"."session_id"',
    );
    expect(params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, SESSION]),
    );
  });

  it("inserts a link once per session and URL", () => {
    const { sql } = insertRunPullRequest(db, {
      ...SCOPE,
      sessionId: SESSION,
      url: "https://github.com/acme/api/pull/42",
      key: { provider: "github", repository: "acme/api", number: 42 },
    }).toSQL();
    expect(sql).toContain('on conflict ("session_id","url") do nothing');
  });

  it("writes a dated state only over an older or undated one", () => {
    const at = new Date("2026-09-25T10:00:00Z");
    const { sql, params } = applyForgeState(
      db,
      { orgId: SCOPE.orgId },
      { provider: "github", repository: "Acme/API", number: 42 },
      { state: "merged", draft: true, sourceUpdatedAt: at },
      new Date("2026-09-25T10:00:05Z"),
    ).toSQL();
    expect(sql).toContain(
      '("tacho"."run_pull_requests"."source_updated_at" is null or "tacho"."run_pull_requests"."source_updated_at" <= $',
    );
    // An org-wide write names no workspace.
    expect(sql).not.toContain('"workspace_id" =');
    // The key matches lower-cased, and a merged row is never a draft.
    expect(params).toEqual(expect.arrayContaining(["acme/api", 42, false]));
    expect(params).not.toContain(true);
  });

  it("writes an undated state only over an undated one (negative)", () => {
    const { sql } = applyForgeState(
      db,
      SCOPE,
      { provider: "gitlab", repository: "acme/platform/api", number: 9 },
      { state: "open", draft: true, sourceUpdatedAt: null },
      new Date(),
    ).toSQL();
    expect(sql).toContain(
      '"tacho"."run_pull_requests"."source_updated_at" is null',
    );
    expect(sql).not.toContain("<=");
    expect(sql).toContain('"tacho"."run_pull_requests"."workspace_id" = $');
  });
});
