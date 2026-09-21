import { describe, expect, it } from "vitest";
import { agentSourceSlug, renameAgentSource } from "./source-identity";
import { renameSkillSource, skillSourceName } from "./skill-source-identity";

describe("agent source identity", () => {
  it("reads the parsed root slug rather than prompt text or nested assignments", () => {
    const source = [
      'slug = "actual-agent"',
      'prompt = """',
      'slug = "prompt-agent"',
      '"""',
      "[harness]",
      'slug = "nested-agent"',
    ].join("\n");
    expect(agentSourceSlug(source)).toBe("actual-agent");
    expect(renameAgentSource(source, "new-agent")).toBe(
      source.replace('slug = "actual-agent"', 'slug = "new-agent"'),
    );
  });

  it("preserves spacing, comments, and CRLF around a quoted root key", () => {
    const source = '  "slug" = \'old\'  # keep\r\nname = "Name"\r\n';
    expect(renameAgentSource(source, "new-agent")).toBe(
      '  "slug" = "new-agent"  # keep\r\nname = "Name"\r\n',
    );
    expect(renameAgentSource('slug = "old"\r\n', "new")).toBe(
      'slug = "new"\r\n',
    );
  });

  it("replaces a multiline slug and preserves the closing comment", () => {
    const source = 'slug = """\nold\\\n""" # keep\nprompt = "hello"\n';
    expect(renameAgentSource(source, "new")).toBe(
      'slug = "new" # keep\nprompt = "hello"\n',
    );
  });

  it("adds a missing slug at the root without changing a nested slug", () => {
    const source = '# keep\r\n[harness]\r\nslug = "nested"\r\n';
    expect(renameAgentSource(source, "new-agent")).toBe(
      '# keep\r\nslug = "new-agent"\r\n[harness]\r\nslug = "nested"\r\n',
    );
    expect(agentSourceSlug(source)).toBeNull();
  });

  it.each(["", "Upper", "../path", "bad--name", "a".repeat(19)])(
    "rejects invalid agent name %j",
    (name) => {
      expect(agentSourceSlug(`slug = "${name}"`)).toBeNull();
      expect(renameAgentSource('slug = "old"', name)).toBeNull();
    },
  );

  it("refuses to rename an unreadable draft", () => {
    const source = 'slug = "old"\nprompt = "unfinished';
    expect(agentSourceSlug(source)).toBeNull();
    expect(renameAgentSource(source, "new")).toBeNull();
  });
});

describe("skill source identity", () => {
  it("reads the plain frontmatter name and preserves the body and other fields", () => {
    const source =
      "---\r\nname : old  \r\nversion: 1.0.0\r\n---\r\nname: body\r\n";
    expect(skillSourceName(source)).toBe("old");
    expect(renameSkillSource(source, "new-skill")).toBe(
      "---\r\nname : new-skill  \r\nversion: 1.0.0\r\n---\r\nname: body\r\n",
    );
  });

  it("adds a missing name inside existing frontmatter", () => {
    expect(renameSkillSource("---\nversion: 1.0.0\n---\n# Body", "new")).toBe(
      "---\nname: new\nversion: 1.0.0\n---\n# Body",
    );
  });

  it("refuses duplicate name fields just as the proposal reader does", () => {
    const source = "---\nname: first\nname: last\n---\nname: body";
    expect(skillSourceName(source)).toBeNull();
    expect(renameSkillSource(source, "new")).toBeNull();
  });

  it.each(["name: old", "---\nname: old", " ---\nname: old\n---"])(
    "refuses malformed frontmatter %j",
    (source) => {
      expect(skillSourceName(source)).toBeNull();
      expect(renameSkillSource(source, "new")).toBeNull();
    },
  );

  it.each(["", "bad--name", "a".repeat(49)])(
    "rejects invalid skill name %j",
    (name) => {
      expect(skillSourceName(`---\nname: ${name}\n---`)).toBeNull();
      expect(renameSkillSource("---\nname: old\n---", name)).toBeNull();
    },
  );
});
