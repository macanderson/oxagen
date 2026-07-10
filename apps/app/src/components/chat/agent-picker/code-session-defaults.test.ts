/**
 * code-session-defaults.test.ts — repo/env default resolution from workspace
 * preferences.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDefaultRepoKey,
  resolveDefaultEnvId,
} from "./code-session-defaults";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

const REPOS: RepoOption[] = [
  {
    key: "con_1::acme/api",
    connectionId: "con_1",
    owner: "acme",
    name: "api",
    defaultBranch: "main",
  },
  {
    key: "con_1::acme/web",
    connectionId: "con_1",
    owner: "acme",
    name: "web",
    defaultBranch: null,
  },
];

const ENVS: EnvironmentOption[] = [
  { id: "env_prod", name: "Production", isDefault: false },
  { id: "env_dev", name: "Development", isDefault: true },
];

describe("resolveDefaultRepoKey", () => {
  it("resolves a saved default to its live repo key", () => {
    expect(resolveDefaultRepoKey(REPOS, "con_1", "acme/web")).toBe(
      "con_1::acme/web",
    );
  });

  it("returns null when no default is set", () => {
    expect(resolveDefaultRepoKey(REPOS, null, null)).toBeNull();
    expect(resolveDefaultRepoKey(REPOS, "con_1", null)).toBeNull();
  });

  it("returns null when the default no longer maps to an available repo", () => {
    expect(resolveDefaultRepoKey(REPOS, "con_1", "acme/gone")).toBeNull();
    expect(resolveDefaultRepoKey(REPOS, "con_other", "acme/api")).toBeNull();
  });
});

describe("resolveDefaultEnvId", () => {
  it("prefers the saved default when it still exists", () => {
    expect(resolveDefaultEnvId(ENVS, "env_prod")).toBe("env_prod");
  });

  it("falls back to the workspace isDefault env when the saved default is gone", () => {
    expect(resolveDefaultEnvId(ENVS, "env_missing")).toBe("env_dev");
    expect(resolveDefaultEnvId(ENVS, null)).toBe("env_dev");
  });

  it("returns null when there is no default and no isDefault env", () => {
    expect(
      resolveDefaultEnvId([{ id: "env_a", name: "A", isDefault: false }], null),
    ).toBeNull();
  });
});
