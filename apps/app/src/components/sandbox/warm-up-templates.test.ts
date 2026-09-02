import { describe, it, expect } from "vitest";
import {
  WARM_UP_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  templateById,
} from "./warm-up-templates";

describe("warm-up-templates", () => {
  it("exposes a non-empty, uniquely-ided template set", () => {
    expect(WARM_UP_TEMPLATES.length).toBeGreaterThan(0);
    const ids = WARM_UP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a resolvable default template", () => {
    expect(WARM_UP_TEMPLATES.some((t) => t.id === DEFAULT_TEMPLATE_ID)).toBe(
      true,
    );
    expect(templateById(DEFAULT_TEMPLATE_ID).id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it("falls back to the default for unknown/empty ids", () => {
    expect(templateById("does-not-exist").id).toBe(DEFAULT_TEMPLATE_ID);
    expect(templateById(null).id).toBe(DEFAULT_TEMPLATE_ID);
    expect(templateById(undefined).id).toBe(DEFAULT_TEMPLATE_ID);
  });

  it("the oxagen-agent template scaffolds a warm workspace on the agent image", () => {
    const t = templateById("oxagen-agent");
    expect(t.image).toBe("agent");
    expect(t.setupCmd).toContain("git init");
    expect(t.setupCmd).toContain("README.md");
    expect(t.setupCmd).toContain(".oxagen/AGENT.md");
  });

  it("the blank template has no warm-up command", () => {
    expect(templateById("blank").setupCmd).toBe("");
  });

  it("every setupCmd is a single sh-safe line (no comment terminator, no newlines)", () => {
    for (const t of WARM_UP_TEMPLATES) {
      // setupCmd is passed as one `sh -c` string — it must not contain a raw
      // newline, and must never contain a block-comment terminator that could
      // break the source it's embedded in.
      expect(t.setupCmd).not.toContain("\n");
      expect(t.setupCmd).not.toContain("*/");
    }
  });

  it("only uses images accepted by agent.sandbox.start", () => {
    const allowed = new Set(["agent", "node", "python", "shell"]);
    for (const t of WARM_UP_TEMPLATES) {
      expect(allowed.has(t.image)).toBe(true);
    }
  });
});
