import { describe, expect, it } from "vitest";
import {
  ContentError,
  countWords,
  groupByPillar,
  loadPillars,
  parseFrontmatter,
  readingMinutes,
  relatedPosts,
  sortPosts,
  validatePost,
  WORDS_PER_MINUTE,
} from "./content.mjs";

const image = (n) => `
    image:
      src: /assets/blog/pillars/${n}.jpg
      alt: A picture
      credit:
        author: Someone
        authorUrl: https://unsplash.com/@someone
        source: Unsplash
        sourceUrl: https://unsplash.com/photos/abc
        license: Unsplash License`;

const PILLARS_YAML = `
pillars:
  - slug: beta
    name: Beta
    tagline: Second.
    description: The second pillar.
    order: 2${image("beta")}
  - slug: alpha
    name: Alpha
    tagline: First.
    description: The first pillar.
    order: 1${image("alpha")}
`;

describe("loadPillars", () => {
  it("parses, normalises, and sorts by order", () => {
    const pillars = loadPillars(PILLARS_YAML);
    expect(pillars.map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(pillars[0].image.credit.license).toBe("Unsplash License");
    expect(pillars[0].description).toBe("The first pillar.");
  });

  it("rejects an empty file", () => {
    expect(() => loadPillars("pillars: []")).toThrow(ContentError);
    expect(() => loadPillars("")).toThrow(/non-empty/);
  });

  it("rejects duplicate and malformed slugs", () => {
    const dup = PILLARS_YAML.replace("slug: alpha", "slug: beta");
    expect(() => loadPillars(dup)).toThrow(/duplicate slug/);
    const bad = PILLARS_YAML.replace("slug: alpha", "slug: Alpha_One");
    expect(() => loadPillars(bad)).toThrow(/kebab-case/);
  });

  it("requires every field including the image credit", () => {
    expect(() =>
      loadPillars(PILLARS_YAML.replace("tagline: First.", 'tagline: ""')),
    ).toThrow(/`tagline` is required/);
    expect(() =>
      loadPillars(PILLARS_YAML.replace("order: 1", "order: first")),
    ).toThrow(/`order` must be an integer/);
    expect(() =>
      loadPillars(
        PILLARS_YAML.replace(
          "src: /assets/blog/pillars/alpha.jpg",
          "src: alpha.jpg",
        ),
      ),
    ).toThrow(/site-absolute/);
    expect(() =>
      loadPillars(PILLARS_YAML.replace("alt: A picture", 'alt: ""')),
    ).toThrow(/image.alt/);
    expect(() =>
      loadPillars(
        PILLARS_YAML.replace("license: Unsplash License", 'license: ""'),
      ),
    ).toThrow(/image.credit.license/);
  });
});

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the body", () => {
    const { data, body } = parseFrontmatter("---\ntitle: Hi\n---\n\n# Body\n");
    expect(data).toEqual({ title: "Hi" });
    expect(body).toBe("\n# Body\n");
  });

  it("handles CRLF and rejects missing or non-mapping frontmatter", () => {
    expect(parseFrontmatter("---\r\ntitle: Hi\r\n---\r\nBody").data).toEqual({
      title: "Hi",
    });
    expect(() => parseFrontmatter("# no frontmatter", "x.mdx")).toThrow(
      /x.mdx: missing YAML frontmatter/,
    );
    expect(() => parseFrontmatter("---\n- a\n- b\n---\n")).toThrow(
      /YAML mapping/,
    );
  });
});

describe("countWords / readingMinutes", () => {
  it("ignores code, footnote definitions, JSX, and markdown punctuation", () => {
    const body = [
      "## Heading here",
      "",
      "One two three.[^1] **four** _five_",
      "",
      "```js",
      "const x = 1; // not counted at all",
      "```",
      "",
      '<Callout kind="note">six seven</Callout>',
      "",
      "| a | b |",
      "|---|---|",
      "| eight | nine |",
      "",
      "[^1]: Author (2020). *A very long reference title that should not count*. https://example.com",
    ].join("\n");
    expect(countWords(body)).toBe(13);
  });

  it("rounds to a minimum of one minute", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(WORDS_PER_MINUTE * 3)).toBe(3);
    expect(readingMinutes(WORDS_PER_MINUTE * 3.6)).toBe(4);
  });
});

describe("validatePost", () => {
  const pillars = [{ slug: "alpha" }, { slug: "beta" }];
  const good = {
    title: " Title ",
    description: "Desc",
    date: "2026-09-09",
    authors: ["Oxagen Research"],
    pillars: ["alpha", "beta"],
    tags: ["one-two"],
  };

  it("normalises a valid post", () => {
    const post = validatePost(good, { slug: "my-post", pillars });
    expect(post).toEqual({
      slug: "my-post",
      title: "Title",
      description: "Desc",
      date: "2026-09-09",
      updated: null,
      pillars: ["alpha", "beta"],
      authors: ["Oxagen Research"],
      tags: ["one-two"],
      image: null,
      draft: false,
    });
  });

  it("accepts YAML-parsed Date objects and an updated date", () => {
    const post = validatePost(
      {
        ...good,
        date: new Date("2026-01-02T00:00:00Z"),
        updated: new Date("2026-02-03T00:00:00Z"),
      },
      { slug: "p", pillars },
    );
    expect(post.date).toBe("2026-01-02");
    expect(post.updated).toBe("2026-02-03");
  });

  it("rejects unknown, duplicate, or missing pillars", () => {
    expect(() =>
      validatePost(
        { ...good, pillars: ["gamma"] },
        { slug: "p", pillars, file: "p.mdx" },
      ),
    ).toThrow(/p.mdx: unknown pillar "gamma"/);
    expect(() =>
      validatePost(
        { ...good, pillars: ["alpha", "alpha"] },
        { slug: "p", pillars },
      ),
    ).toThrow(/same pillar twice/);
    expect(() =>
      validatePost({ ...good, pillars: [] }, { slug: "p", pillars }),
    ).toThrow(/at least one pillar/);
  });

  it("rejects bad slugs, dates, descriptions, authors, tags, and images", () => {
    expect(() => validatePost(good, { slug: "Bad_Slug", pillars })).toThrow(
      /kebab-case/,
    );
    expect(() =>
      validatePost({ ...good, date: "9 Sept 2026" }, { slug: "p", pillars }),
    ).toThrow(/ISO date/);
    expect(() =>
      validatePost({ ...good, updated: "soon" }, { slug: "p", pillars }),
    ).toThrow(/`updated` must be an ISO date/);
    expect(() =>
      validatePost(
        { ...good, description: "x".repeat(201) },
        { slug: "p", pillars },
      ),
    ).toThrow(/201 chars/);
    expect(() =>
      validatePost({ ...good, title: "" }, { slug: "p", pillars }),
    ).toThrow(/`title` is required/);
    expect(() =>
      validatePost({ ...good, authors: [] }, { slug: "p", pillars }),
    ).toThrow(/at least one author/);
    expect(() =>
      validatePost({ ...good, tags: ["Not Kebab"] }, { slug: "p", pillars }),
    ).toThrow(/tag "Not Kebab"/);
    expect(() =>
      validatePost({ ...good, image: "hero.jpg" }, { slug: "p", pillars }),
    ).toThrow(/`image` must be a site-absolute/);
    expect(
      validatePost(
        { ...good, image: "/x.jpg", draft: true },
        { slug: "p", pillars },
      ),
    ).toMatchObject({ image: "/x.jpg", draft: true });
  });
});

describe("ordering and grouping", () => {
  const posts = [
    { slug: "a", title: "B title", date: "2026-01-01", pillars: ["alpha"] },
    {
      slug: "b",
      title: "A title",
      date: "2026-01-01",
      pillars: ["alpha", "beta"],
    },
    { slug: "c", title: "C", date: "2026-03-01", pillars: ["beta"] },
    { slug: "d", title: "D", date: "2025-12-01", pillars: ["gamma"] },
  ];

  it("sorts newest first, then by title, without mutating", () => {
    const sorted = sortPosts(posts);
    expect(sorted.map((p) => p.slug)).toEqual(["c", "b", "a", "d"]);
    expect(posts[0].slug).toBe("a");
  });

  it("groups posts under every pillar they link and keeps empty pillars", () => {
    const groups = groupByPillar(
      [{ slug: "alpha" }, { slug: "beta" }, { slug: "empty" }],
      posts,
    );
    expect(groups.get("alpha").map((p) => p.slug)).toEqual(["a", "b"]);
    expect(groups.get("beta").map((p) => p.slug)).toEqual(["b", "c"]);
    expect(groups.get("empty")).toEqual([]);
    expect(groups.has("gamma")).toBe(false);
  });

  it("ranks related posts by shared pillars, primary first", () => {
    const related = relatedPosts(posts[1], posts);
    expect(related.map((p) => p.slug)).toEqual(["a", "c"]);
    expect(relatedPosts(posts[3], posts)).toEqual([]);
    expect(relatedPosts(posts[1], posts, 1).map((p) => p.slug)).toEqual(["a"]);
  });
});
