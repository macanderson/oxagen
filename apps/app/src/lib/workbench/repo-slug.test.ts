/**
 * repo-slug.test.ts — unit tests for `parseRepoSlug`, the pure `owner/repo`
 * parser shared by server actions and client components. Covers every
 * branch: valid slug, missing/leading/trailing slash, the "(+N more)"
 * multi-repo suffix, whitespace trimming, and extra path segments.
 */
import { describe, it, expect } from "vitest";

import { parseRepoSlug } from "./repo-slug";

describe("parseRepoSlug", () => {
  it("parses a valid owner/repo slug", () => {
    expect(parseRepoSlug("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("returns null when there is no slash", () => {
    expect(parseRepoSlug("GitHub")).toBeNull();
  });

  it("returns null for a leading slash (empty owner)", () => {
    expect(parseRepoSlug("/widgets")).toBeNull();
  });

  it("returns null for a trailing slash (empty repo)", () => {
    expect(parseRepoSlug("acme/")).toBeNull();
  });

  it("strips the '(+N more)' multi-repo suffix before parsing", () => {
    expect(parseRepoSlug("acme/widgets (+3 more)")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("strips a double-digit '(+N more)' suffix", () => {
    expect(parseRepoSlug("acme/widgets (+12 more)")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("trims surrounding whitespace on the whole display name", () => {
    expect(parseRepoSlug("  acme/widgets  ")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("trims whitespace around the slash separator", () => {
    expect(parseRepoSlug("acme / widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("returns null for an empty string", () => {
    expect(parseRepoSlug("")).toBeNull();
  });

  it("returns null for a lone slash", () => {
    expect(parseRepoSlug("/")).toBeNull();
  });

  it("folds extra path segments into the repo portion", () => {
    expect(parseRepoSlug("acme/widgets/extra")).toEqual({ owner: "acme", repo: "widgets/extra" });
  });

  it("returns null when the display name is just the suffix with no slug", () => {
    expect(parseRepoSlug("GitHub (+3 more)")).toBeNull();
  });
});
