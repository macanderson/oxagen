import { describe, expect, it } from "vitest";
import {
  changelogEntry,
  compareSemverDesc,
  escapeMdx,
  fallbackNotes,
  loadSkills,
  parseNotes,
  proseHits,
  releasePageMdx,
  releasesMeta,
  retryPrompt,
  sanitizeLine,
  SKILL_FILES,
  systemPrompt,
  userPrompt,
} from "./lib/release-notes";

const ROOT = new URL("../../", import.meta.url).pathname;

const HISTORY = {
  fromRef: "v2.1.1",
  version: "2.1.2",
  log: "- fix(app): keep the Spend page's budget as a string (5a01dca)\n- agents: Configuration tab as a form over the file (f4cf21)",
  stat: " 2 files changed, 40 insertions(+), 3 deletions(-)",
  diff: "diff --git a/x b/x\n+const a = 1;",
};

const GOOD =
  "SUMMARY: The Spend page shows an agent's budget as entered, and the Agents page edits an agent's file as a form.\n\n## What changed\n\n- The Spend page kept a budget as a number and rounded it. It now keeps the string you typed.\n- The Configuration tab on an agent's page is a form over the agent file, with a coloured source view beside it.";

describe("the model's instructions", () => {
  it("are the two writing skills, read from the tree", () => {
    const skills = loadSkills(ROOT);
    for (const rel of SKILL_FILES)
      expect(skills).toContain(`<skill path="${rel}">`);
    expect(skills).toContain("No em dashes");
    const system = systemPrompt(skills);
    expect(system).toContain("workforce management for autonomous agents");
    expect(system).toContain("SUMMARY:");
    expect(system).toContain("## What changed");
    expect(system).toContain("Do not list every commit");
  });

  it("refuse to run without a skill file rather than write unguided", () => {
    expect(() => loadSkills("/nonexistent")).toThrow(/clear-prose\/SKILL\.md/);
  });

  it("hand the model the log, the diffstat and the diff", () => {
    const prompt = userPrompt(HISTORY);
    expect(prompt).toContain("Version 2.1.2. Changes since v2.1.1.");
    expect(prompt).toContain(HISTORY.log);
    expect(prompt).toContain(HISTORY.stat);
    expect(prompt).toContain("```diff\n" + HISTORY.diff);
    expect(userPrompt({ ...HISTORY, log: "", stat: "", diff: "" })).toContain(
      "(none)",
    );
  });

  it("lead with the maintainer's headline when one is given, and only then", () => {
    const prompt = userPrompt({
      ...HISTORY,
      highlight: "The desktop installer for tacho.",
    });
    expect(prompt).toContain("## The headline");
    expect(prompt).toContain("The desktop installer for tacho.");
    expect(prompt.indexOf("## The headline")).toBeLessThan(
      prompt.indexOf("## Commit log"),
    );
    expect(userPrompt(HISTORY)).not.toContain("## The headline");
    expect(userPrompt({ ...HISTORY, highlight: "  " })).not.toContain(
      "## The headline",
    );
  });
});

describe("parseNotes", () => {
  it("splits a well-shaped answer into summary and body", () => {
    const notes = parseNotes(GOOD);
    expect(notes?.summary).toBe(
      "The Spend page shows an agent's budget as entered, and the Agents page edits an agent's file as a form.",
    );
    expect(notes?.body.startsWith("## What changed")).toBe(true);
    expect(notes?.body).toContain("Configuration tab");
  });

  it("tolerates a code fence and case, and refuses anything else", () => {
    expect(parseNotes("```markdown\n" + GOOD + "\n```")).not.toBeNull();
    expect(parseNotes(GOOD.replace("SUMMARY:", "summary:"))).not.toBeNull();
    expect(parseNotes("Here are the notes:\n\n" + GOOD)).toBeNull();
    expect(parseNotes("SUMMARY: fine\n\nNo heading here at all")).toBeNull();
    expect(parseNotes("SUMMARY: \n\n## What changed\n\nshort")).toBeNull();
    expect(parseNotes("")).toBeNull();
  });
});

describe("the prose gate", () => {
  it("finds what the docs scanner finds", () => {
    expect(proseHits(parseNotes(GOOD)!)).toEqual([]);
    const hits = proseHits({
      summary: "A seamless release — really!",
      body: "## What changed\n\n- Very robust now.",
    });
    expect(hits.join("\n")).toMatch(/em dash/);
    expect(hits.join("\n")).toMatch(/avoid: seamless/);
    expect(hits.join("\n")).toMatch(/avoid: robust/);
    expect(hits.join("\n")).toMatch(/exclamation/);
  });

  it("asks for a rewrite with the findings and the previous answer", () => {
    const notes = parseNotes(GOOD)!;
    const prompt = retryPrompt(notes, ["line 1 [em dash]: x"]);
    expect(prompt).toContain("- line 1 [em dash]: x");
    expect(prompt).toContain(`SUMMARY: ${notes.summary}`);
    expect(prompt).toContain(notes.body);
  });

  it("sanitises a line to the mechanical rules", () => {
    expect(sanitizeLine("fix — the thing – and more -- done!")).toBe(
      "fix, the thing, and more, done.",
    );
    expect(sanitizeLine("keep this! really")).toBe("keep this. really");
    expect(sanitizeLine("v1.0 -> ok")).toBe("v1.0 -> ok");
  });
});

describe("fallbackNotes", () => {
  it("summarises the commit log honestly and cleanly", () => {
    const notes = fallbackNotes({
      ...HISTORY,
      log: "- fix: a — b (abc1234)\n- feat: wow! (def5678)",
    });
    expect(notes.summary).toBe(
      "Version 2.1.2 carries 2 changes since v2.1.1. The list below is the commit log; a written summary was not available for this release.",
    );
    expect(notes.body).toBe("## What changed\n\n- fix: a, b\n- feat: wow.");
    expect(proseHits(notes)).toEqual([]);
  });

  it("says so when there is nothing", () => {
    const notes = fallbackNotes({ ...HISTORY, log: "" });
    expect(notes.summary).toContain("no changes");
    expect(notes.body).toContain("No commits since the previous release.");
  });

  it("leaves a subject the scanner still rejects in the commit log, and says so", () => {
    const notes = fallbackNotes({
      ...HISTORY,
      log: "- make the gateway more robust (abc1234)\n- fix: a thing (def5678)\n- add observability hooks (0123456)",
    });
    expect(notes.body).toBe(
      "## What changed\n\n- fix: a thing\n\nAnd 2 more, in the commit log.",
    );
    expect(notes.summary).toContain("carries 3 changes");
    expect(proseHits(notes)).toEqual([]);
  });

  it("escapes what MDX would read as JSX or an expression", () => {
    expect(escapeMdx("replace <img> with <Image> in {layout}")).toBe(
      "replace \\<img\\> with \\<Image\\> in \\{layout\\}",
    );
    expect(escapeMdx("a \\ b")).toBe("a \\\\ b");
    const notes = fallbackNotes({
      ...HISTORY,
      log: "- fix(app): replace <img> with <Image> (abc1234)",
    });
    expect(notes.body).toContain(
      "- fix(app): replace \\<img\\> with \\<Image\\>",
    );
    expect(proseHits(notes)).toEqual([]);
  });

  it("caps a long log", () => {
    const log = Array.from(
      { length: 45 },
      (_, i) => `- change ${i} (0000000)`,
    ).join("\n");
    const notes = fallbackNotes({ ...HISTORY, log });
    expect(notes.body).toContain("- change 39");
    expect(notes.body).not.toContain("- change 40");
    expect(notes.body).toContain("And 5 more, in the commit log.");
  });
});

describe("what gets written", () => {
  const notes = parseNotes(GOOD)!;

  it("is a docs page with frontmatter, the downloads block, then the notes", () => {
    const mdx = releasePageMdx({ version: "2.1.2", date: "2026-09-19", notes });
    expect(mdx.startsWith('---\ntitle: v2.1.2\ndescription: "')).toBe(true);
    expect(mdx).toContain('\ndate: "2026-09-19"\n---\n');
    expect(mdx).toContain('<ReleaseDownloads version="2.1.2" />');
    expect(mdx.indexOf("<ReleaseDownloads")).toBeLessThan(
      mdx.indexOf("## What changed"),
    );
    // A double quote in the summary would end the YAML string early.
    const quoted = releasePageMdx({
      version: "1.0.0",
      date: "d",
      notes: { summary: 'Says "hi"', body: notes.body },
    });
    expect(quoted).toContain("description: \"Says 'hi'\"");
  });

  it("is a changelog entry under the version heading", () => {
    const entry = changelogEntry("2.1.2", notes);
    expect(
      entry.startsWith(
        "## v2.1.2\n\n" + notes.summary + "\n\n- The Spend page",
      ),
    ).toBe(true);
    expect(entry).not.toContain("## What changed");
  });

  it("orders the sidebar newest first, whatever the old order was", () => {
    const first = releasesMeta(null, "2.1.1");
    expect(JSON.parse(first)).toEqual({
      title: "Releases",
      pages: ["index", "v2.1.1"],
    });
    const next = releasesMeta(first, "2.10.0");
    const again = releasesMeta(next, "2.9.0");
    expect(JSON.parse(again).pages).toEqual([
      "index",
      "v2.10.0",
      "v2.9.0",
      "v2.1.1",
    ]);
    // Re-running a version does not duplicate it; junk is rewritten.
    expect(JSON.parse(releasesMeta(again, "2.9.0")).pages).toEqual([
      "index",
      "v2.10.0",
      "v2.9.0",
      "v2.1.1",
    ]);
    expect(JSON.parse(releasesMeta("{not json", "1.0.0")).pages).toEqual([
      "index",
      "v1.0.0",
    ]);
    expect(
      JSON.parse(releasesMeta('{"pages":["index","stray",3]}', "1.0.0")).pages,
    ).toEqual(["index", "v1.0.0"]);
  });

  it("compares versions numerically", () => {
    expect(
      ["2.9.0", "2.10.0", "10.0.0", "2.10.1"].sort(compareSemverDesc),
    ).toEqual(["10.0.0", "2.10.1", "2.10.0", "2.9.0"]);
    expect(compareSemverDesc("1.0.0", "1.0.0")).toBe(0);
  });
});
