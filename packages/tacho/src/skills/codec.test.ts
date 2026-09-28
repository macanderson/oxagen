import { describe, expect, it } from "vitest";
import { bundleSigner, unsignedBundle } from "../host/test-support";
import {
  BUNDLE_FEATURE_SKILLS,
  BUNDLE_SKILLS_CHARS_MAX,
  TACHO_BUNDLE_FEATURES,
  bundleSkillSchema,
  policyBundleSchema,
  type BundleSkill,
} from "../wire";
import { decodeSkill, encodeSkill } from "./codec";
import type { SessionSkill } from "./place";

const BYTES = new Uint8Array(256).map((_, index) => index);

const SKILL: SessionSkill = {
  lineage: "a-intel.brand-voice",
  name: "a-intel-brand-voice",
  description: "Write in the brand voice.",
  body: "Use the style guide.\n",
  files: [
    { path: "reference/style.md", content: "# Style\n" },
    { path: "assets/logo.png", content: BYTES },
  ],
  source: "workspace",
  version: 21,
};

describe("the skill codec", () => {
  it("sends text as utf8 and bytes as base64, and reads both back unchanged", () => {
    const wire = encodeSkill(SKILL);
    expect(wire.files).toEqual([
      { path: "reference/style.md", encoding: "utf8", content: "# Style\n" },
      {
        path: "assets/logo.png",
        encoding: "base64",
        content: Buffer.from(BYTES).toString("base64"),
      },
    ]);
    expect(bundleSkillSchema.parse(wire)).toEqual(wire);
    const back = decodeSkill(bundleSkillSchema.parse(JSON.parse(JSON.stringify(wire))));
    expect(back.files[0]).toEqual(SKILL.files[0]);
    expect(back.files[1]?.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(back.files[1]?.content as Uint8Array)).toEqual(Array.from(BYTES));
    expect({ ...back, files: [] }).toEqual({ ...SKILL, files: [] });
  });
});

describe("the bundle's skills", () => {
  const skills: BundleSkill[] = [encodeSkill(SKILL)];

  it("is a feature this host advertises, so the control plane sends it", () => {
    expect(TACHO_BUNDLE_FEATURES).toContain(BUNDLE_FEATURE_SKILLS);
    expect(BUNDLE_FEATURE_SKILLS).toBe("skills");
  });

  it("parses a signed bundle carrying skills", () => {
    const bundle = bundleSigner().sign(unsignedBundle({ skills }));
    expect(policyBundleSchema.parse(bundle).skills).toEqual(skills);
  });

  it("parses a bundle without skills, which means none", () => {
    const bundle = bundleSigner().sign(unsignedBundle());
    expect(policyBundleSchema.parse(bundle).skills).toBeUndefined();
  });

  it.each([
    ["a file that is not base64", { ...skills[0], files: [{ path: "a.bin", encoding: "base64", content: "not base64" }] }],
    ["a folder name that is not a skill name", { ...skills[0], name: "../escape" }],
    ["an unknown field", { ...skills[0], surprise: true }],
  ])("refuses the whole bundle for %s", (_label, skill) => {
    const bundle = bundleSigner().sign(unsignedBundle());
    expect(policyBundleSchema.safeParse({ ...bundle, skills: [skill] }).success).toBe(false);
  });

  it("refuses skills over the character cap", () => {
    const big = { ...skills[0], body: "x".repeat(BUNDLE_SKILLS_CHARS_MAX) };
    const bundle = bundleSigner().sign(unsignedBundle());
    expect(policyBundleSchema.safeParse({ ...bundle, skills: [big] }).success).toBe(false);
  });
});
