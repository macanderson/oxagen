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
  harness: "claude-code",
  repository: {} as ConfigurationSource["repository"],
});
describe("configuration clone source projection", () => {
  it("copies agent configuration and harness settings without identity-bound fields", () => {
    const original = source(
      "agent",
      'schema="agent-definition/v0.1"\nslug="review"\nname="Review"\ntools=["read_file"]\nprincipal_id="old"\ncredential="secret"\n[harness.claude-code]\ncolor="gold"',
    );
    const parsed = parse(
      clonedConfigurationText(original, "review-cloned", "Review-cloned"),
    );
    expect(parsed).toEqual({
      schema: "agent-definition/v0.1",
      slug: "review-cloned",
      name: "Review-cloned",
      tools: ["read_file"],
      harness: { "claude-code": { color: "gold" } },
    });
    expect(original.source).toContain('principal_id="old"');
  });
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
      title: "Review-cloned",
      kind: "rule",
      force: "must",
      sharingScope: "workspace",
      statement: "Review changes.",
    });
  });
  it("refuses source identity mismatches", () => {
    expect(() =>
      clonedConfigurationText(
        source("agent", 'slug="other"'),
        "review-cloned",
        "Review-cloned",
      ),
    ).toThrow();
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
  });
});

describe("clone editor identity", () => {
  it.each(["agent", "record"] as const)(
    "uses explicit %s identity while retaining edited configuration",
    (kind) => {
      const text = applyCloneIdentity({
        kind,
        sourceId: "original",
        sourceDigest: "a".repeat(64),
        slug: "chosen-clone",
        name: "Chosen clone",
        files: [],
        harness: null,
        source:
          kind === "agent"
            ? 'slug="stale"\nname="Stale"\ninstructions="Edited instructions"'
            : 'lineageId="stale"\ntitle="Stale"\nstatement="Edited claim"',
      });
      expect(parse(text)).toEqual(
        kind === "agent"
          ? {
              slug: "chosen-clone",
              name: "Chosen clone",
              instructions: "Edited instructions",
            }
          : {
              lineageId: "chosen-clone",
              title: "Chosen clone",
              statement: "Edited claim",
            },
      );
    },
  );
  it("uses the chosen skill slug and retains edited instructions", () => {
    const text = applyCloneIdentity({
      kind: "skill",
      sourceId: "original",
      sourceDigest: "a".repeat(64),
      slug: "chosen-clone",
      name: "chosen-clone",
      files: [],
      harness: null,
      source:
        '---\nname: stale\nversion: "1.0.0"\nscope: workspace\n---\nEdited instructions',
    });
    expect(readSkillFrontmatter(text)?.fields.name).toBe("chosen-clone");
    expect(text).toContain("Edited instructions");
  });
});
