import { describe, it, expect } from "vitest";
import { inferMediaIntent } from "./infer-media-intent";

describe("inferMediaIntent — image intent", () => {
  it.each([
    "generate an image of a sunset over the ocean",
    "create a logo for my startup called Acme",
    "make me a picture of a golden retriever",
    "draw a portrait of my dog",
    "design a poster for the launch event",
    "paint a picture of the ocean at sunset",
    "generate a wallpaper of a galaxy",
    "please create an illustration of a robot chef",
    "render an image of a futuristic city",
    "generate a headshot for my profile",
  ])("infers image from: %s", (prompt) => {
    expect(inferMediaIntent(prompt)).toBe("image");
  });

  it("handles verb inflections (created / making / drew / generates)", () => {
    expect(inferMediaIntent("i already created an illustration earlier")).toBe(
      "image",
    );
    expect(inferMediaIntent("making a logo right now")).toBe("image");
    expect(inferMediaIntent("drew a picture of the team")).toBe("image");
    expect(inferMediaIntent("it generates a photo automatically")).toBe(
      "image",
    );
  });
});

describe("inferMediaIntent — video intent", () => {
  it.each([
    "make me a short video of waves crashing",
    "create an animation of a bouncing ball",
    "generate a gif of a cat typing",
    "produce a clip for the ad campaign",
    "create a trailer for the game",
    "animate a short clip of the mascot",
  ])("infers video from: %s", (prompt) => {
    expect(inferMediaIntent(prompt)).toBe("video");
  });

  it("prefers video when both image and video are requested", () => {
    expect(inferMediaIntent("create a video and a matching poster")).toBe(
      "video",
    );
  });
});

describe("inferMediaIntent — precision (no false positives in dev chat)", () => {
  it.each([
    // media noun immediately followed by a disqualifying technical tail
    "create a video codec in rust",
    "add a photo upload field to the form",
    "wire up the video player component",
    "generate an image url for the avatar",
    "design an image picker library",
    // no generation verb targeting a curated media noun
    "build an image classifier with pytorch",
    "explain how video streaming works",
    "how do i render thumbnails in next.js",
    "create a helper to render thumbnails",
    "make the submit button blue",
    "make a plan for next sprint",
    "design a database schema for orders",
    "summarize this photo-heavy article",
    "what's the best video conferencing tool",
  ])("does NOT fire for: %s", (prompt) => {
    expect(inferMediaIntent(prompt)).toBeNull();
  });

  it("ignores a media noun far from the generation verb", () => {
    // "create" targets "plan"; the later "image" is >6 words away and un-verbed.
    expect(
      inferMediaIntent(
        "create a detailed plan first and then we can talk about whether an image belongs anywhere",
      ),
    ).toBeNull();
  });
});

describe("inferMediaIntent — guards", () => {
  it("never fires when the user attached media (asking ABOUT it)", () => {
    expect(
      inferMediaIntent("make this image brighter", { hasAttachments: true }),
    ).toBeNull();
  });

  it("never fires on a code-mode turn", () => {
    expect(
      inferMediaIntent("generate an image of the architecture", {
        isCodeMode: true,
      }),
    ).toBeNull();
  });

  it("returns null for empty / punctuation-only prompts", () => {
    expect(inferMediaIntent("")).toBeNull();
    expect(inferMediaIntent("   ")).toBeNull();
    expect(inferMediaIntent("!!! ??? ...")).toBeNull();
  });
});
