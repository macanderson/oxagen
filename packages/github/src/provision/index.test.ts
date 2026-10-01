import { describe, expect, it } from "vitest";
import * as deployment from "./deployment";
import * as firstCommit from "./first-commit";
import * as http from "./http";
import * as provision from "./index";
import * as repository from "./repository";
import * as settings from "./settings";

/** Each value the barrel exports, taken from the module that defines it. */
const SOURCES: Record<string, unknown> = {
  createGithubRest: http.createGithubRest,
  RATE_LIMIT_RETRY_MS: http.RATE_LIMIT_RETRY_MS,
  addRepositoryToInstallation: repository.addRepositoryToInstallation,
  candidateName: repository.candidateName,
  createOrAdoptRepository: repository.createOrAdoptRepository,
  createRepository: repository.createRepository,
  getRepository: repository.getRepository,
  getUserLogin: repository.getUserLogin,
  listSteeringInstallations: repository.listSteeringInstallations,
  SteeringReauthorizeError: repository.SteeringReauthorizeError,
  STEERING_BRANCH: firstCommit.STEERING_BRANCH,
  writeFirstCommit: firstCommit.writeFirstCommit,
  applySettings: settings.applySettings,
  compareSettings: settings.compareSettings,
  readSettings: settings.readSettings,
  rulesetBody: settings.rulesetBody,
  rulesetKey: settings.rulesetKey,
  recordDeployment: deployment.recordDeployment,
};

describe("@oxagen/github/provision", () => {
  // A module namespace is not a plain object, so toEqual cannot compare it with
  // one. The tests compare its names and then each value.
  it("exports each step and nothing else", () => {
    expect(Object.keys(provision).sort()).toEqual(Object.keys(SOURCES).sort());
  });

  it("re-exports each value from the module that defines it", () => {
    for (const [name, value] of Object.entries(SOURCES))
      expect(Reflect.get(provision, name), name).toBe(value);
  });

  it("keeps the path segment helper inside the package", () => {
    expect(Object.keys(provision)).not.toContain("seg");
  });
});
