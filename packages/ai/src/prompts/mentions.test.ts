import { describe, expect, it } from "vitest";

import {
  MENTION_TOKEN_REGEX,
  MENTION_TYPES,
  applyMentionPlaceholders,
  matchMentionTypes,
  mentionFromHref,
  mentionGrammarPrompt,
  mentionToHref,
  mentionTypeInfo,
  parseMentions,
  serializeMention,
  splitTextByMentions,
  stripMentions,
  textWithMentionLinks,
  type ChatMention,
} from "./mentions";

const fileMention: ChatMention = {
  type: "file",
  slug: "apps/app/src/proxy.ts",
  location: "apps/app/src/proxy.ts",
  label: "proxy.ts",
};

describe("serializeMention / parseMentions", () => {
  it("round-trips a simple mention", () => {
    const token = serializeMention(fileMention);
    expect(token).toBe(
      "[:file|:apps/app/src/proxy.ts|:apps/app/src/proxy.ts|:proxy.ts]",
    );
    const parsed = parseMentions(`please look at ${token} first`)[0]!;
    expect(parsed).toMatchObject(fileMention);
    expect(parsed.raw).toBe(token);
    expect(parsed.start).toBe("please look at ".length);
    expect(parsed.end).toBe(parsed.start + token.length);
  });

  it("percent-encodes structural characters and round-trips them", () => {
    const nasty: ChatMention = {
      type: "node",
      slug: "node_abc123",
      location: "graph://org/ws?q=a|b",
      label: "Weird ]name| 100%",
    };
    const token = serializeMention(nasty);
    expect(token).not.toMatch(/\|(?!:)/); // no unencoded pipes inside fields
    const parsed = parseMentions(token)[0]!;
    expect(parsed).toMatchObject(nasty);
  });

  it("round-trips newlines in labels", () => {
    const m: ChatMention = {
      type: "edge",
      slug: "edge_1",
      location: "",
      label: "two\nlines",
    };
    const parsed = parseMentions(serializeMention(m))[0]!;
    expect(parsed.label).toBe("two\nlines");
  });

  it("parses multiple mentions in document order", () => {
    const a = serializeMention({ ...fileMention, label: "a" });
    const b = serializeMention({
      type: "agent",
      slug: "agt_1",
      location: "",
      label: "Reviewer",
    });
    const parsed = parseMentions(`${a} and ${b}`);
    expect(parsed.map((p) => p.label)).toEqual(["a", "Reviewer"]);
  });

  it("ignores unknown types and malformed tokens", () => {
    const text =
      "[:martian|:x|:y|:z] [:file|:only-two-fields] [:file|:a|:b|:c]";
    const parsed = parseMentions(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: "file", slug: "a" });
  });

  it("returns an empty array for text without tokens", () => {
    expect(parseMentions("no tokens here [not:one]")).toEqual([]);
  });

  it("is immune to a caller leaving the shared regex's lastIndex advanced", () => {
    const token = serializeMention(fileMention);
    const text = `see ${token} now`;
    // A stateful `.test()` (as MarkdownMessage runs for detection) advances the
    // shared /g regexp's lastIndex; parseMentions must still find the token.
    MENTION_TOKEN_REGEX.lastIndex = 0;
    expect(MENTION_TOKEN_REGEX.test(text)).toBe(true);
    expect(MENTION_TOKEN_REGEX.lastIndex).toBeGreaterThan(0);
    const parsed = parseMentions(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject(fileMention);
  });
});

describe("splitTextByMentions", () => {
  it("splits text into interleaved segments", () => {
    const token = serializeMention(fileMention);
    const segments = splitTextByMentions(`fix ${token} now`);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: "text", text: "fix " });
    expect(segments[1]?.kind).toBe("mention");
    expect(segments[2]).toEqual({ kind: "text", text: " now" });
  });

  it("handles token-only and empty text", () => {
    const token = serializeMention(fileMention);
    expect(splitTextByMentions(token)).toHaveLength(1);
    expect(splitTextByMentions("")).toEqual([{ kind: "text", text: "" }]);
  });
});

describe("stripMentions", () => {
  it("replaces tokens with @Label markers", () => {
    const token = serializeMention(fileMention);
    expect(stripMentions(`fix ${token} now`)).toBe("fix @proxy.ts now");
  });
});

describe("mention type registry", () => {
  it("covers every type with metadata", () => {
    for (const info of MENTION_TYPES) {
      expect(mentionTypeInfo(info.type)).toBe(info);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.summary.length).toBeGreaterThan(0);
    }
  });

  it("matches types by prefix against type, label, and plural", () => {
    expect(matchMentionTypes("")).toHaveLength(MENTION_TYPES.length);
    expect(matchMentionTypes("rep").map((t) => t.type)).toContain("repository");
    expect(matchMentionTypes("mcp").map((t) => t.type)).toEqual(["mcp_server"]);
    expect(matchMentionTypes("graph").map((t) => t.type)).toEqual([
      "node",
      "edge",
    ]);
    expect(matchMentionTypes("zzz")).toEqual([]);
  });
});

describe("applyMentionPlaceholders", () => {
  const pending = (label: string, slug = "s1") => ({
    placeholder: `@${label}`,
    mention: { type: "file", slug, location: slug, label } as const,
  });

  it("replaces a placeholder with the serialized token", () => {
    const out = applyMentionPlaceholders("fix @proxy.ts now", [
      pending("proxy.ts"),
    ]);
    expect(out).toBe("fix [:file|:s1|:s1|:proxy.ts] now");
  });

  it("requires word boundaries — edited placeholders are dropped", () => {
    expect(
      applyMentionPlaceholders("fix @proxy.tsx now", [pending("proxy.ts")]),
    ).toBe("fix @proxy.tsx now");
    expect(
      applyMentionPlaceholders("mail me@proxy.ts now", [pending("proxy.ts")]),
    ).toBe("mail me@proxy.ts now");
  });

  it("allows trailing punctuation after the placeholder", () => {
    const out = applyMentionPlaceholders("see @proxy.ts.", [
      pending("proxy.ts"),
    ]);
    expect(out).toBe("see [:file|:s1|:s1|:proxy.ts].");
  });

  it("maps duplicate labels to occurrences in insertion order", () => {
    const out = applyMentionPlaceholders("@a then @a", [
      pending("a", "first"),
      pending("a", "second"),
    ]);
    expect(out).toBe(
      "[:file|:first|:first|:a] then [:file|:second|:second|:a]",
    );
  });
});

describe("mention href bridge", () => {
  it("round-trips a mention through the href", () => {
    const m: ChatMention = {
      type: "node",
      slug: "node_1",
      location: "graph://node/node_1",
      label: "Billing Policy (v2)",
    };
    const href = mentionToHref(m);
    expect(href.startsWith("oxagen-mention://node?")).toBe(true);
    expect(href).not.toContain("(");
    expect(mentionFromHref(href)).toEqual(m);
  });

  it("rejects non-mention hrefs", () => {
    expect(mentionFromHref("https://example.com")).toBeNull();
    expect(mentionFromHref("oxagen-mention://bogus?slug=x&label=y")).toBeNull();
    expect(mentionFromHref("oxagen-mention://node?label=y")).toBeNull();
  });

  it("converts tokens to markdown links", () => {
    const token = serializeMention(fileMention);
    const out = textWithMentionLinks(`fix ${token} now`);
    expect(out).toMatch(
      /^fix \[proxy\.ts\]\(oxagen-mention:\/\/file\?.*\) now$/,
    );
  });
});

describe("mentionGrammarPrompt", () => {
  it("documents the grammar and every type", () => {
    const prompt = mentionGrammarPrompt();
    expect(prompt).toContain("[:TYPE|:SLUG|:LOCATION|:LABEL]");
    for (const info of MENTION_TYPES) {
      expect(prompt).toContain(`\`${info.type}\``);
    }
  });
});
