import { describe, it, expect } from "vitest";
import { toSentenceCase } from "./to-sentence-case";

describe("toSentenceCase", () => {
  it("lowercases every word but the first", () => {
    expect(toSentenceCase("Continue The Thread")).toBe("Continue the thread");
  });

  it("preserves the pronoun I mid-sentence", () => {
    expect(toSentenceCase("What Can I Do Here?")).toBe("What can I do here?");
  });

  it("preserves an acronym (2+ consecutive uppercase letters)", () => {
    expect(toSentenceCase("Fix CI Failures")).toBe("Fix CI failures");
  });

  it("preserves an acronym even as the first word", () => {
    expect(toSentenceCase("API Key Review")).toBe("API key review");
  });

  it("preserves a word containing a digit", () => {
    expect(toSentenceCase("Set Up Q4 Budget")).toBe("Set up Q4 budget");
  });

  it("preserves a quoted word", () => {
    expect(toSentenceCase('Rename The "Foo" Field')).toBe('Rename the "Foo" field');
  });

  it("preserves a backtick-quoted word", () => {
    expect(toSentenceCase("Run `oxagen dev` Now")).toBe("Run `oxagen dev` now");
  });

  it("preserves an I contraction", () => {
    expect(toSentenceCase("I'll Handle This Later")).toBe("I'll handle this later");
  });

  it("leaves a single-word label capitalized", () => {
    expect(toSentenceCase("Automate")).toBe("Automate");
  });

  it("returns an empty string unchanged", () => {
    expect(toSentenceCase("")).toBe("");
  });

  it("does not mis-treat a single capital letter as an acronym", () => {
    // "A" alone is not 2+ consecutive uppercase letters, so it lowercases —
    // unlike the special-cased pronoun "I".
    expect(toSentenceCase("Pick A Model")).toBe("Pick a model");
  });
});
