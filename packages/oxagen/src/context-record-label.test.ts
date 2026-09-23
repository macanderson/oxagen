import { describe, expect, it } from "vitest";
import { contextRecordLabel, contextRecordSlug } from "./context-record-label";

describe("context record names", () => {
  it("derives readable labels without changing record identity", () => {
    expect(contextRecordLabel("release-checklist")).toBe("Release Checklist");
    expect(contextRecordLabel("ctx.product.RELEASE_checklist")).toBe(
      "Ctx Product Release Checklist",
    );
    expect(contextRecordLabel("déploiement---réussi!")).toBe(
      "Déploiement Réussi",
    );
    expect(contextRecordLabel("---")).toBe("Context Record");
  });
  it("normalizes editable names to file-safe slugs", () => {
    expect(contextRecordSlug(" Release / Checklist! ")).toBe(
      "release-checklist",
    );
    expect(contextRecordSlug("Déploiement réussi")).toBe("deploiement-reussi");
    expect(contextRecordSlug("ctx.core.release-checklist")).toBe(
      "ctx.core.release-checklist",
    );
    expect(contextRecordSlug("../../")).toBe("");
    expect(contextRecordSlug("a".repeat(300))).toHaveLength(200);
  });
});
