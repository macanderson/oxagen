import { describe, expect, it } from "vitest";
import {
  STEERING_RECORD_LABEL_MAX,
  steeringRecordLabel,
  steeringRecordSlug,
  fitSteeringRecordLabel,
} from "./steering-record-label";

describe("steering record names", () => {
  it("derives readable labels without changing record identity", () => {
    expect(steeringRecordLabel("release-checklist")).toBe("Release Checklist");
    expect(steeringRecordLabel("ctx.product.RELEASE_checklist")).toBe(
      "Release Checklist",
    );
    expect(steeringRecordLabel("ctx.direct-publish")).toBe("Ctx Direct Publish");
    expect(steeringRecordLabel("déploiement---réussi!")).toBe(
      "Déploiement Réussi",
    );
    expect(steeringRecordLabel("---")).toBe("Steering Record");
  });
  it("normalizes editable names to file-safe slugs", () => {
    expect(steeringRecordSlug(" Release / Checklist! ")).toBe(
      "release-checklist",
    );
    expect(steeringRecordSlug("Déploiement réussi")).toBe("deploiement-reussi");
    expect(steeringRecordSlug("ctx.core.release-checklist")).toBe(
      "ctx.core.release-checklist",
    );
    expect(steeringRecordSlug("../../")).toBe("");
    expect(steeringRecordSlug("a".repeat(300))).toHaveLength(200);
  });
  it("fits a label to 36 characters on a word boundary", () => {
    expect(STEERING_RECORD_LABEL_MAX).toBe(36);
    expect(fitSteeringRecordLabel("  No   local builds  ")).toBe(
      "No local builds",
    );
    const long = "Do not build typecheck or run every unit test locally";
    const fitted = fitSteeringRecordLabel(long);
    expect(fitted).toBe("Do not build typecheck or run every");
    expect(fitted.length).toBeLessThanOrEqual(36);
    expect(fitSteeringRecordLabel("x".repeat(50))).toBe("x".repeat(36));
    expect(fitSteeringRecordLabel("a".repeat(36))).toHaveLength(36);
  });
  it("caps a derived label at the same limit", () => {
    const label = steeringRecordLabel(
      "ctx.product.do-not-build-typecheck-or-run-the-full-suite-locally",
    );
    expect(label).toBe("Do Not Build Typecheck Or Run The");
    expect(label.length).toBeLessThanOrEqual(STEERING_RECORD_LABEL_MAX);
  });
});
