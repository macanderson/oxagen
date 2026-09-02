import { describe, expect, it } from "vitest";
import { createSkillRegistry } from "./registry";
import type { Skill } from "./types";

const skill = (slug: string, over: Partial<Skill> = {}): Skill => ({
  slug,
  name: over.name ?? slug,
  description: over.description ?? `${slug} description`,
  metadata: over.metadata,
  body: over.body ?? "",
  references: over.references ?? [],
  source: over.source ?? "tenant",
  version: over.version ?? "1",
});

// fsRoot points at a path that does not exist; scanSkillsDir tolerates a
// missing directory and returns [], so these tests exercise the merge,
// filter, get, and refresh logic hermetically off the injected dbAdapter.
const NO_FS = "/nonexistent/skills-root";

describe("createSkillRegistry", () => {
  it("lists skills sourced from the db adapter", async () => {
    const reg = createSkillRegistry({
      fsRoot: NO_FS,
      dbAdapter: async () => [skill("alpha"), skill("beta")],
    });
    const names = (await reg.list()).map((s) => s.slug).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("filters by slug, name, or description (case-insensitive)", async () => {
    const reg = createSkillRegistry({
      fsRoot: NO_FS,
      dbAdapter: async () => [
        skill("summarize", { name: "Summarize", description: "condense text" }),
        skill("translate", {
          name: "Translate",
          description: "convert languages",
        }),
      ],
    });
    expect((await reg.list("SUMMAR")).map((s) => s.slug)).toEqual([
      "summarize",
    ]);
    expect((await reg.list("languages")).map((s) => s.slug)).toEqual([
      "translate",
    ]);
    expect(await reg.list("nope")).toEqual([]);
  });

  it("resolves a single skill by slug", async () => {
    const reg = createSkillRegistry({
      fsRoot: NO_FS,
      dbAdapter: async () => [skill("alpha")],
    });
    expect((await reg.get("alpha"))?.slug).toBe("alpha");
    expect(await reg.get("missing")).toBeUndefined();
  });

  it("refresh() clears the cache so the adapter is re-read", async () => {
    let calls = 0;
    const reg = createSkillRegistry({
      fsRoot: NO_FS,
      dbAdapter: async () => {
        calls += 1;
        return [skill("alpha")];
      },
    });
    await reg.list();
    await reg.list();
    expect(calls).toBe(1); // cached
    await reg.refresh();
    await reg.list();
    expect(calls).toBe(2); // re-read after refresh
  });
});
