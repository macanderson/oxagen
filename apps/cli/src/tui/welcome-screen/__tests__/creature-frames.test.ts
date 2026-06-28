import { describe, test, expect } from "vitest";
import { DRAGON_FRAMES, ANIMATION_CONFIG } from "../creature-frames.js";

describe("creature-frames", () => {
  describe("DRAGON_FRAMES", () => {
    test("has exactly 6 frames", () => {
      expect(DRAGON_FRAMES).toHaveLength(6);
    });

    test("all frames are non-empty strings", () => {
      DRAGON_FRAMES.forEach((frame, i) => {
        expect(typeof frame).toBe("string");
        expect(frame.length).toBeGreaterThan(0);
      });
    });

    test("frames 0-3 are breathing cycle (no fire chars)", () => {
      const fireChars = ["*", "≈", "~"];
      DRAGON_FRAMES.slice(0, 4).forEach((frame, i) => {
        fireChars.forEach((char) => {
          expect(frame.includes(char)).toBe(false);
        });
      });
    });

    test("frames 4-5 contain fire effects", () => {
      const fireChars = ["*", "≈", "~"];
      DRAGON_FRAMES.slice(4).forEach((frame, i) => {
        const hasFireChar = fireChars.some((char) => frame.includes(char));
        expect(hasFireChar).toBe(true);
      });
    });

    test("all frames have similar dimensions", () => {
      const lines = DRAGON_FRAMES.map((f) => f.split("\n").filter((l) => l.length > 0));
      const heights = lines.map((l) => l.length);
      
      // All heights should be within 2 lines of each other
      const minHeight = Math.min(...heights);
      const maxHeight = Math.max(...heights);
      expect(maxHeight - minHeight).toBeLessThanOrEqual(2);
    });

    test("frames contain dragon body parts", () => {
      // Check for recognizable dragon elements
      const allFrames = DRAGON_FRAMES.join("");
      expect(allFrames).toContain("()"); // Eyes
      expect(allFrames).toContain("<>"); // Snout
      expect(allFrames).toContain("___"); // Body
    });
  });

  describe("ANIMATION_CONFIG", () => {
    test("has valid frame delay", () => {
      expect(ANIMATION_CONFIG.frameDelay).toBeGreaterThan(0);
      expect(ANIMATION_CONFIG.frameDelay).toBeLessThanOrEqual(1000);
    });

    test("totalFrames matches array length", () => {
      expect(ANIMATION_CONFIG.totalFrames).toBe(DRAGON_FRAMES.length);
    });

    test("cycleDuration is frameDelay * totalFrames", () => {
      const expected = ANIMATION_CONFIG.frameDelay * ANIMATION_CONFIG.totalFrames;
      expect(ANIMATION_CONFIG.cycleDuration).toBe(expected);
    });

    test("frame rate is approximately 5 FPS", () => {
      const fps = 1000 / ANIMATION_CONFIG.frameDelay;
      expect(fps).toBeCloseTo(5, 1);
    });
  });
});
