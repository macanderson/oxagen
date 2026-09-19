// The theme control in assets/oxagen.js, run against a stub page. The file
// ships to the browser as written, with no module wrapper, so it is loaded
// here the way a <script> tag loads it: evaluated once in its own context.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../assets/oxagen.js", import.meta.url)),
  "utf8",
);

function makeButton(choice) {
  const listeners = {};
  return {
    attrs: { "data-theme-choice": choice },
    tabIndex: 0,
    focused: false,
    getAttribute(k) {
      return this.attrs[k];
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    focus() {
      this.focused = true;
    },
    click() {
      listeners.click?.();
    },
  };
}

/**
 * Loads oxagen.js into a page with one theme control.
 * `storage` is "ok" (a working localStorage) or "blocked" (every call throws).
 */
function loadPage({ osLight = false, storage = "ok", stored = null } = {}) {
  const store = new Map(stored ? [["theme", stored]] : []);
  const localStorage = {
    getItem(k) {
      if (storage === "blocked") throw new Error("SecurityError");
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (storage === "blocked") throw new Error("SecurityError");
      store.set(k, v);
    },
  };
  const buttons = ["system", "light", "dark"].map(makeButton);
  const groupListeners = {};
  const group = {
    addEventListener(type, fn) {
      groupListeners[type] = fn;
    },
    querySelectorAll: () => buttons,
  };
  const scheme = { content: "light dark" };
  // The head carries one theme-color tag per OS preference, and oxagen.js reads
  // `media` to know which is which: a pinned theme sets both to its own colour,
  // System puts each back to the one it answers for.
  const themeColors = [
    { media: "(prefers-color-scheme: light)", content: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", content: "#09090B" },
  ];
  const root = {
    attrs: {},
    offsetWidth: 0,
    classList: { add() {}, remove() {} },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
  const osListeners = [];
  const colorQuery = {
    matches: osLight,
    addEventListener(_type, fn) {
      osListeners.push(fn);
    },
  };
  const document = {
    documentElement: root,
    getElementById: () => null,
    querySelector: (sel) =>
      sel === 'meta[name="color-scheme"]' ? scheme : null,
    querySelectorAll(sel) {
      if (sel === "[data-theme-choice]") return buttons;
      if (sel === ".theme-switch") return [group];
      if (sel === 'meta[name="theme-color"]') return themeColors;
      return [];
    },
  };
  const window = {
    matchMedia: (q) =>
      q.includes("prefers-color-scheme") ? colorQuery : { matches: true },
    addEventListener() {},
  };
  vm.runInNewContext(SOURCE, {
    window,
    document,
    localStorage,
    location: { hostname: "oxagen.sh", pathname: "/", search: "" },
  });
  const checked = () =>
    buttons.find((b) => b.attrs["aria-checked"] === "true")?.attrs[
      "data-theme-choice"
    ];
  return {
    buttons,
    store,
    scheme,
    themeColors,
    root,
    checked,
    press: (key) => groupListeners.keydown({ key, preventDefault() {} }),
    flipOs(light) {
      colorQuery.matches = light;
      for (const fn of osListeners) fn();
    },
  };
}

describe("oxagen.js theme control", () => {
  it("follows the OS when nothing is stored", () => {
    const page = loadPage({ osLight: true });
    expect(page.root.attrs["data-theme"]).toBe("light");
    expect(page.checked()).toBe("system");
    page.flipOs(false);
    expect(page.root.attrs["data-theme"]).toBe("dark");
  });

  it("stores a pinned choice and paints the browser chrome in it", () => {
    const page = loadPage({ osLight: true });
    page.buttons[2].click();
    expect(page.store.get("theme")).toBe("dark");
    expect(page.root.attrs["data-theme"]).toBe("dark");
    expect(page.scheme.content).toBe("dark");
    expect(page.themeColors.map((m) => m.content)).toEqual([
      "#09090B",
      "#09090B",
    ]);
    // System hands each tag back to the preference it answers for, so the OS
    // drives the chrome again rather than both tags being stuck on one colour.
    page.buttons[0].click();
    expect(page.themeColors.map((m) => m.content)).toEqual([
      "#FFFFFF",
      "#09090B",
    ]);
  });

  it("keeps a choice for the page view when storage refuses it", () => {
    const page = loadPage({ osLight: false, storage: "blocked" });
    page.buttons[1].click();
    expect(page.root.attrs["data-theme"]).toBe("light");
    // An OS change does not undo the pinned choice.
    page.flipOs(true);
    page.flipOs(false);
    expect(page.root.attrs["data-theme"]).toBe("light");
    expect(page.checked()).toBe("light");
    // The arrow key steps from the choice on screen, Light, to Dark.
    page.press("ArrowRight");
    expect(page.checked()).toBe("dark");
    expect(page.buttons[2].focused).toBe(true);
  });

  it("arrow keys wrap around the three choices", () => {
    const page = loadPage({ stored: "system" });
    page.press("ArrowLeft");
    expect(page.checked()).toBe("dark");
    page.press("ArrowRight");
    expect(page.checked()).toBe("system");
  });
});
