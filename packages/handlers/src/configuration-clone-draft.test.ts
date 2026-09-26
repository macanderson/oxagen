import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import type { ConfigurationSource } from "./configuration-clone-source";
import {
  applyCloneIdentity,
  clonedConfigurationText,
} from "./configuration-clone-draft";
import { readSkillFrontmatter } from "./skill-validation";
import { buildRecordFile } from "./context.steering.file";
import { stringify } from "smol-toml";
const source = (
  kind: ConfigurationSource["kind"],
  text: string,
): ConfigurationSource => ({
  kind,
  id: "review",
  slug: "review",
  name: "Review",
  source: text,
  files: [],
  repository: {} as ConfigurationSource["repository"],
});
describe("configuration clone source projection", () => {
  it("updates only the skill name while retaining quoted version and instructions", () => {
    const original = source(
      "skill",
      '---\nname: review\nversion: "1.0.0"\nscope: workspace\ndescription: Review code\n---\nKeep this body.\n',
    );
    const text = clonedConfigurationText(
      original,
      "review-cloned",
      "review-cloned",
    );
    expect(readSkillFrontmatter(text)?.fields).toMatchObject({
      name: "review-cloned",
      version: "1.0.0",
      scope: "workspace",
    });
    expect(text).toContain("Keep this body.");
    expect(original.source).toContain("name: review\n");
  });
  it("copies the record claim under a distinct lineage without historical ids or publication stamps", () => {
    const original = source(
      "record",
      stringify(
        buildRecordFile({
          lineageId: "review",
          kind: "rule",
          force: "must",
          sharingScope: "workspace",
          statement: "Review changes.",
          origin: "user",
          proposalPublicId: "cpr_old",
          setId: "acme.core",
        }),
      ),
    );
    expect(
      parse(
        clonedConfigurationText(original, "review-cloned", "Review-cloned"),
      ),
    ).toEqual({
      lineageId: "review-cloned",
      label: "Review-cloned",
      kind: "rule",
      force: "must",
      sharingScope: "workspace",
      statement: "Review changes.",
    });
  });
  it("refuses source identity mismatches", () => {
    expect(() =>
      clonedConfigurationText(
        source(
          "skill",
          '---\nname: other\nversion: "1.0.0"\nscope: workspace\n---\nBody',
        ),
        "review-cloned",
        "Review-cloned",
      ),
    ).toThrow();
    expect(() =>
      clonedConfigurationText(
        source("record", 'schema="context-record/v0.1"\nrecord=[]'),
        "review-cloned",
        "Review-cloned",
      ),
    ).toThrow();
  });
});

describe("clone editor identity", () => {
  it("uses the explicit record identity while retaining edited configuration", () => {
    const text = applyCloneIdentity({
      kind: "record",
      sourceId: "original",
      sourceDigest: "a".repeat(64),
      slug: "chosen-clone",
      name: "Chosen clone",
      files: [],
      source: 'lineageId="stale"\ntitle="Stale"\nstatement="Edited claim"',
    });
    expect(parse(text)).toEqual({
      // A record's name is its label (ADR-178). A title the editor left in
      // the source stays, since it names nothing.
      lineageId: "chosen-clone",
      title: "Stale",
      label: "Chosen clone",
      statement: "Edited claim",
    });
  });
  it("uses the chosen skill slug and retains edited instructions", () => {
    const text = applyCloneIdentity({
      kind: "skill",
      sourceId: "original",
      sourceDigest: "a".repeat(64),
      slug: "chosen-clone",
      name: "chosen-clone",
      files: [],
      source:
        '---\nname: stale\nversion: "1.0.0"\nscope: workspace\n---\nEdited instructions',
    });
    expect(readSkillFrontmatter(text)?.fields.name).toBe("chosen-clone");
    expect(text).toContain("Edited instructions");
  });
});
