import { describe, expect, it } from "vitest";
import {
  CONTEXT_RECORD_LABEL_MAX,
  contextRecordLabel,
  contextRecordSlug,
  fitContextRecordLabel,
} from "./context-record-label";

describe("context record names", () => {
  it("derives readable labels without changing record identity", () => {
    expect(contextRecordLabel("release-checklist")).toBe("Release Checklist");
    expect(contextRecordLabel("ctx.product.RELEASE_checklist")).toBe(
      "Release Checklist",
    );
    expect(contextRecordLabel("ctx.direct-publish")).toBe("Ctx Direct Publish");
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
  it("fits a label to 36 characters on a word boundary", () => {
    expect(CONTEXT_RECORD_LABEL_MAX).toBe(36);
    expect(fitContextRecordLabel("  No   local builds  ")).toBe(
      "No local builds",
    );
    const long = "Do not build typecheck or run every unit test locally";
    const fitted = fitContextRecordLabel(long);
    expect(fitted).toBe("Do not build typecheck or run every");
    expect(fitted.length).toBeLessThanOrEqual(36);
    expect(fitContextRecordLabel("x".repeat(50))).toBe("x".repeat(36));
    expect(fitContextRecordLabel("a".repeat(36))).toHaveLength(36);
  });
  it("caps a derived label at the same limit", () => {
    const label = contextRecordLabel(
      "ctx.product.do-not-build-typecheck-or-run-the-full-suite-locally",
    );
    expect(label).toBe("Do Not Build Typecheck Or Run The");
    expect(label.length).toBeLessThanOrEqual(CONTEXT_RECORD_LABEL_MAX);
  });
});
