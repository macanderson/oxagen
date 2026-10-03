// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelLabel,
  ProviderMark,
  providerIdOf,
  providerNameOf,
} from "./provider-mark";
import { PROVIDER_MARKS } from "./provider-marks";

afterEach(cleanup);

describe("providerIdOf", () => {
  it.each([
    ["anthropic", null, "anthropic"],
    ["Anthropic", null, "anthropic"],
    ["gemini", null, "google"],
    ["z-ai", null, "zai"],
    ["openai_compatible", null, null],
    ["moonshot", null, "moonshot"],
    ["gateway", null, "vercel"],
  ])("reads the recorded provider %s", (provider, model, id) => {
    expect(providerIdOf(provider, model)).toBe(id);
  });

  it.each([
    ["claude-opus-4-5", "anthropic"],
    ["anthropic/claude-sonnet-5", "anthropic"],
    ["z-ai/glm-latest", "zai"],
    ["glm-flash-latest", "zai"],
    ["openrouter/z-ai/glm-latest", "zai"],
    ["gpt-5", "openai"],
    ["o3-mini", "openai"],
    ["google/gemini-2.5-flash", "google"],
    ["x-ai/grok-4", "xai"],
    ["meta-llama/llama-4-maverick", "meta"],
    ["deepseek-chat", "deepseek"],
  ])("reads the maker out of the model id %s", (model, id) => {
    expect(providerIdOf(null, model)).toBe(id);
  });

  it("prefers the maker the model names over a router", () => {
    expect(providerIdOf("openrouter", "anthropic/claude-sonnet-5")).toBe(
      "anthropic",
    );
    expect(providerIdOf("openrouter", null)).toBe("openrouter");
  });

  it("keeps a named maker over a guess from the model id", () => {
    expect(providerIdOf("anthropic", "gpt-5")).toBe("anthropic");
  });

  it.each(["", "custom", "__proto__", "constructor", "toString"])(
    "answers null for %j",
    (provider) => {
      expect(providerIdOf(provider, "in-house-model-v3")).toBeNull();
    },
  );
});

describe("ProviderMark", () => {
  it("draws the maker's mark as an inline currentColor SVG", () => {
    const { container } = render(<ProviderMark model="claude-opus-4-5" />);
    const svg = container.querySelector("svg[data-provider-mark]");
    expect(svg?.getAttribute("data-provider-mark")).toBe("anthropic");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws nothing for an unknown provider", () => {
    const { container } = render(
      <ProviderMark provider="acme" model="acme-1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("draws every registry mark from path data alone", () => {
    for (const id of Object.keys(PROVIDER_MARKS)) {
      const { container, unmount } = render(<ProviderMark provider={id} />);
      const svg = container.querySelector(`svg[data-provider-mark="${id}"]`);
      expect(svg, id).not.toBeNull();
      expect(svg?.querySelectorAll("path").length, id).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("ModelLabel", () => {
  it("shows the model's name beside its maker's mark", () => {
    const { container } = render(<ModelLabel model="z-ai/glm-latest" />);
    expect(screen.getByText("z-ai/glm-latest")).toBeTruthy();
    expect(
      container
        .querySelector("svg[data-provider-mark]")
        ?.getAttribute("data-provider-mark"),
    ).toBe("zai");
  });

  it("prints the maker's name when asked", () => {
    render(<ModelLabel model="claude-opus-4-5" showProvider />);
    expect(screen.getByText("Anthropic")).toBeTruthy();
  });

  it("keeps an unknown model readable with no mark and no name", () => {
    const { container } = render(
      <ModelLabel model="in-house-model-v3" showProvider />,
    );
    expect(screen.getByText("in-house-model-v3")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(providerNameOf(null, "in-house-model-v3")).toBeNull();
  });
});
