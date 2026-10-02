// modules.ts registers the collector modules a build ships.
import { afterEach, describe, expect, it } from "vitest";
import { githubCollector } from "../github";
import { registerCollectorModules } from "../modules";
import { getCollector, listCollectorTypes, unregisterCollector } from "../registry";
import type { CollectorType } from "../types";
import { createFakeCollector, erased } from "./fake";

/** Every type a test here registers. afterEach removes each one. */
const TYPES: readonly CollectorType[] = ["github", "jira"];

afterEach(() => {
  for (const type of TYPES) unregisterCollector(type);
});

describe("registerCollectorModules", () => {
  it("registers each module in the list it is given", () => {
    const github = createFakeCollector({ type: "github" });
    const jira = createFakeCollector({ type: "jira" });
    registerCollectorModules([{ github: github.definition }, { jira: jira.definition }]);
    expect(getCollector("github")).toBe(erased(github));
    expect(getCollector("jira")).toBe(erased(jira));
  });

  it("ships the GitHub Issues collector", () => {
    registerCollectorModules();
    expect(getCollector("github")).toBe(githubCollector);
  });

  it("registers the shipped list without throwing, and a second call changes nothing", () => {
    expect(() => registerCollectorModules()).not.toThrow();
    const after = listCollectorTypes();
    expect(() => registerCollectorModules()).not.toThrow();
    expect(listCollectorTypes()).toEqual(after);
  });

  it("is safe to call twice and keeps the definitions from the first call", () => {
    const first = createFakeCollector({ type: "github" });
    const second = createFakeCollector({ type: "github" });
    registerCollectorModules([{ github: first.definition }]);
    expect(() => registerCollectorModules([{ github: second.definition }])).not.toThrow();
    expect(getCollector("github")).toBe(erased(first));
  });

  it("throws for a module with no definition and keeps the modules listed before it", () => {
    const github = createFakeCollector({ type: "github" });
    const jira = createFakeCollector({ type: "jira" });
    expect(() =>
      registerCollectorModules([
        { github: github.definition },
        { helper: () => 1 },
        { jira: jira.definition },
      ]),
    ).toThrow("the module exports no CollectorDefinition");
    expect(getCollector("github")).toBe(erased(github));
    expect(getCollector("jira")).toBeUndefined();
  });
});
