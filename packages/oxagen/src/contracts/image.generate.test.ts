import { describe, expect, it } from "vitest";
import { imageGenerate } from "./image.generate";

describe("image.generate capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = imageGenerate.input.parse({
      prompt: "A sunset over the ocean",
    });
    expect(parsed.prompt).toBe("A sunset over the ocean");
    expect(parsed.size).toBeUndefined();
    expect(parsed.alt).toBeUndefined();
  });

  it("parses input with explicit alt and size", () => {
    const parsed = imageGenerate.input.parse({
      prompt: "Abstract gradient art",
      alt: "Colourful abstract art",
      size: "1792x1024",
    });
    expect(parsed.alt).toBe("Colourful abstract art");
    expect(parsed.size).toBe("1792x1024");
  });

  it("rejects an empty prompt", () => {
    expect(() => imageGenerate.input.parse({ prompt: "" })).toThrow();
  });

  it("rejects an invalid size value", () => {
    expect(() =>
      imageGenerate.input.parse({ prompt: "test", size: "512x512" }),
    ).toThrow();
  });

  it("parses a placeholder output (no dataUri)", () => {
    const out = imageGenerate.output.parse({
      alt: "Generated image",
      placeholder: true,
      render: {
        componentId: "image-preview",
        props: { alt: "Generated image", placeholder: true },
      },
    });
    expect(out.placeholder).toBe(true);
    expect(out.dataUri).toBeUndefined();
    expect(out.render.componentId).toBe("image-preview");
  });

  it("parses a successful output with dataUri", () => {
    const out = imageGenerate.output.parse({
      dataUri: "data:image/png;base64,AAABBB",
      alt: "A test image",
      placeholder: false,
      render: {
        componentId: "image-preview",
        props: {
          dataUri: "data:image/png;base64,AAABBB",
          alt: "A test image",
          placeholder: false,
        },
      },
    });
    expect(out.dataUri).toBe("data:image/png;base64,AAABBB");
    expect(out.placeholder).toBe(false);
  });

  it("has the expected contract metadata", () => {
    expect(imageGenerate.name).toBe("generate_image");
    expect(imageGenerate.surfaces).toContain("api");
    expect(imageGenerate.surfaces).toContain("mcp");
    expect(imageGenerate.surfaces).toContain("agent");
    expect(imageGenerate.sensitivity).toBe("low");
    expect(imageGenerate.defaultEffect).toBe("deny");
  });
});
