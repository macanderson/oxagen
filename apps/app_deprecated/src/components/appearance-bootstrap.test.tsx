import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPEARANCE_BOOTSTRAP_SCRIPT,
  AppearanceBootstrap,
} from "./appearance-bootstrap";

/**
 * Execute the bootstrap script against a stubbed `document`, mirroring how a
 * browser runs it during HTML parsing. Returns the mutated documentElement
 * stub so assertions can inspect classes/attributes/styles.
 */
function runScript(cookie: string) {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const style: Record<string, string> = {};
  const documentStub = {
    cookie,
    documentElement: {
      classList: {
        add: (cls: string) => classes.add(cls),
        remove: (cls: string) => classes.delete(cls),
      },
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      style,
    },
  };
  // The script is an IIFE referencing `document`; binding it as a parameter
  // reproduces browser scoping without a DOM environment.
  new Function("document", APPEARANCE_BOOTSTRAP_SCRIPT)(documentStub);
  return { classes, attributes, style };
}

describe("APPEARANCE_BOOTSTRAP_SCRIPT", () => {
  it("applies an explicit dark theme class and color-scheme", () => {
    const { classes, style } = runScript("theme=dark");
    expect(classes.has("dark")).toBe(true);
    expect(style.colorScheme).toBe("dark");
  });

  it("applies an explicit light theme class and color-scheme", () => {
    const { classes, style } = runScript("a=b; theme=light; c=d");
    expect(classes.has("light")).toBe(true);
    expect(style.colorScheme).toBe("light");
  });

  it("leaves html classless for system theme (CSS media query resolves it)", () => {
    const { classes, style } = runScript("theme=system");
    expect(classes.size).toBe(0);
    expect(style.colorScheme).toBeUndefined();
  });

  it("leaves html classless when the theme cookie is absent or invalid", () => {
    expect(runScript("").classes.size).toBe(0);
    expect(runScript("theme=neon").classes.size).toBe(0);
  });

  it("sets data-font-size only for non-default valid values", () => {
    expect(
      runScript("pref-font-size=small").attributes.get("data-font-size"),
    ).toBe("small");
    expect(
      runScript("pref-font-size=large").attributes.get("data-font-size"),
    ).toBe("large");
    // medium is the prerendered default; script must not touch it.
    expect(
      runScript("pref-font-size=medium").attributes.has("data-font-size"),
    ).toBe(false);
    expect(
      runScript("pref-font-size=huge").attributes.has("data-font-size"),
    ).toBe(false);
  });

  it("sets data-density only for non-default valid values", () => {
    expect(
      runScript("pref-density=compact").attributes.get("data-density"),
    ).toBe("compact");
    expect(
      runScript("pref-density=spacious").attributes.get("data-density"),
    ).toBe("spacious");
    expect(
      runScript("pref-density=comfortable").attributes.has("data-density"),
    ).toBe(false);
  });

  it("applies all three preferences from one cookie header", () => {
    const { classes, attributes } = runScript(
      "theme=dark; pref-font-size=large; pref-density=compact",
    );
    expect(classes.has("dark")).toBe(true);
    expect(attributes.get("data-font-size")).toBe("large");
    expect(attributes.get("data-density")).toBe("compact");
  });

  it("decodes URI-encoded cookie values", () => {
    // Values are plain today, but decodeURIComponent must not corrupt them.
    const { classes } = runScript("theme=dark%20");
    expect(classes.size).toBe(0); // "dark " is invalid → ignored
  });

  it("never throws, even with a poisoned document", () => {
    expect(() =>
      new Function("document", APPEARANCE_BOOTSTRAP_SCRIPT)(undefined),
    ).not.toThrow();
  });
});

describe("AppearanceBootstrap", () => {
  it("renders the script inline for the static shell", () => {
    const html = renderToStaticMarkup(<AppearanceBootstrap />);
    expect(html.startsWith("<script>")).toBe(true);
    expect(html).toContain("data-font-size");
    expect(html).toContain("data-density");
    expect(html).toContain("colorScheme=t");
  });
});
