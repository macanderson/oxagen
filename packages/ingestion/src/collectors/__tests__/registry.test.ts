// The registry holds one collector module per type for the whole process, and
// it finds the CollectorDefinition a module file exports.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  getCollector,
  isCollectorDefinition,
  listCollectorTypes,
  registerCollector,
  registerCollectorModule,
  unregisterCollector,
} from "../registry";
import type { CollectorType } from "../types";
import { createFakeCollector, erased } from "./fake";

/** Every type a test here registers. afterEach removes each one. */
const TYPES: readonly CollectorType[] = ["github", "jira", "linear"];

const METHODS = ["verify", "doorbell", "fetchById", "listChangedSince", "toWorkItem"] as const;

const NO_DEFINITION =
  "[collectors] the module exports no CollectorDefinition; export one with type, config, verify, doorbell, fetchById, listChangedSince, and toWorkItem";

afterEach(() => {
  for (const type of TYPES) unregisterCollector(type);
});

/** The fake module's fields as a plain record, less the one named. */
function fakeShapeWithout(name: string): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  const definition = createFakeCollector({ type: "github" }).definition;
  for (const [key, value] of Object.entries(definition)) if (key !== name) shape[key] = value;
  return shape;
}

/** The least a value needs to pass as a CollectorDefinition. */
function minimalShape(): Record<string, unknown> {
  const noop = () => undefined;
  return {
    type: "github",
    config: z.object({}),
    verify: noop,
    doorbell: noop,
    fetchById: noop,
    listChangedSince: noop,
    toWorkItem: noop,
  };
}

describe("registerCollector", () => {
  it("keeps the first module registered for a type and ignores a second", () => {
    const first = createFakeCollector({ type: "github" });
    const second = createFakeCollector({ type: "github" });
    registerCollector(first.definition);
    registerCollector(second.definition);
    expect(getCollector("github")).toBe(erased(first));
    expect(getCollector("github")).not.toBe(erased(second));
  });

  it("shares one registry between two evaluations of the module", async () => {
    vi.resetModules();
    const copy = await import("../registry");
    expect(copy.getCollector).not.toBe(getCollector);

    const first = createFakeCollector({ type: "github" });
    registerCollector(first.definition);
    expect(copy.getCollector("github")).toBe(erased(first));

    copy.registerCollector(createFakeCollector({ type: "github" }).definition);
    expect(getCollector("github")).toBe(erased(first));

    const jira = createFakeCollector({ type: "jira" });
    copy.registerCollector(jira.definition);
    expect(getCollector("jira")).toBe(erased(jira));
  });
});

describe("isCollectorDefinition", () => {
  it("accepts a full collector module and the least shape that passes", () => {
    expect(isCollectorDefinition(createFakeCollector().definition)).toBe(true);
    expect(isCollectorDefinition(minimalShape())).toBe(true);
  });

  it("rejects null and values that are not objects", () => {
    for (const value of [null, undefined, "zendesk", 42, true, () => undefined])
      expect(isCollectorDefinition(value)).toBe(false);
  });

  it("rejects a shape with no type or a type that is not a string", () => {
    expect(isCollectorDefinition(fakeShapeWithout("type"))).toBe(false);
    expect(isCollectorDefinition({ ...minimalShape(), type: 7 })).toBe(false);
  });

  it("rejects a shape whose config is missing or is not a zod schema", () => {
    expect(isCollectorDefinition(fakeShapeWithout("config"))).toBe(false);
    for (const config of [{}, { safeParse: "yes" }, "text", 5])
      expect(isCollectorDefinition({ ...minimalShape(), config })).toBe(false);
  });

  it("rejects a shape that lacks any one of the five methods", () => {
    for (const name of METHODS) {
      expect(isCollectorDefinition(fakeShapeWithout(name))).toBe(false);
      expect(isCollectorDefinition({ ...minimalShape(), [name]: "not a function" })).toBe(false);
    }
  });

  it("rejects a null config and skips that export, so the module's real definition registers", () => {
    const shape = { ...minimalShape(), config: null };
    expect(isCollectorDefinition(shape)).toBe(false);
    const github = createFakeCollector({ type: "github" });
    expect(registerCollectorModule({ broken: shape, github: github.definition })).toEqual([
      "github",
    ]);
    expect(getCollector("github")).toBe(erased(github));
  });
});

describe("registerCollectorModule", () => {
  it("throws for a module that exports no collector definition", () => {
    expect(() => registerCollectorModule({})).toThrow(NO_DEFINITION);
    expect(() =>
      registerCollectorModule({
        helper: () => 1,
        VERSION: "1",
        partial: fakeShapeWithout("verify"),
      }),
    ).toThrow(NO_DEFINITION);
  });

  it("registers each definition a module exports and returns their types in export order", () => {
    const github = createFakeCollector({ type: "github" });
    const jira = createFakeCollector({ type: "jira" });
    const types = registerCollectorModule({
      github: github.definition,
      helper: () => 1,
      jira: jira.definition,
      VERSION: 3,
    });
    expect(types).toEqual(["github", "jira"]);
    expect(getCollector("github")).toBe(erased(github));
    expect(getCollector("jira")).toBe(erased(jira));
  });

  it("returns a type whose registration it skipped because another module holds it", () => {
    const first = createFakeCollector({ type: "github" });
    const second = createFakeCollector({ type: "github" });
    registerCollector(first.definition);
    expect(registerCollectorModule({ second: second.definition })).toEqual(["github"]);
    expect(getCollector("github")).toBe(erased(first));
  });
});

describe("getCollector, listCollectorTypes, and unregisterCollector", () => {
  it("returns undefined for a type with no module", () => {
    expect(getCollector("github")).toBeUndefined();
  });

  it("lists every registered type and drops one once it is removed", () => {
    registerCollector(createFakeCollector({ type: "github" }).definition);
    registerCollector(createFakeCollector({ type: "jira" }).definition);
    expect(listCollectorTypes()).toEqual(expect.arrayContaining(["github", "jira"]));
    unregisterCollector("github");
    expect(listCollectorTypes()).not.toContain("github");
    expect(listCollectorTypes()).toContain("jira");
  });

  it("lets a new module register once the old one is removed", () => {
    const first = createFakeCollector({ type: "github" });
    const second = createFakeCollector({ type: "github" });
    registerCollector(first.definition);
    unregisterCollector("github");
    expect(getCollector("github")).toBeUndefined();
    registerCollector(second.definition);
    expect(getCollector("github")).toBe(erased(second));
  });

  it("does nothing when asked to remove a type that is not registered", () => {
    expect(() => unregisterCollector("linear")).not.toThrow();
    expect(listCollectorTypes()).not.toContain("linear");
  });
});
