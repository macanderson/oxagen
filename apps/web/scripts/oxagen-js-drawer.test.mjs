// The phone menu in assets/oxagen.js, run against a stub page. The file is
// evaluated once in its own context, the way oxagen-js-theme.test.mjs loads
// it, with a burger button, the drawer, and the header's Get a demo link.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../assets/oxagen.js", import.meta.url)),
  "utf8",
);

function makeEl(tagName, attrs = {}) {
  const listeners = {};
  return {
    tagName,
    attrs: { ...attrs },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    /** Fires a click with `target` as the element tapped (bubbling to here). */
    click(target = this) {
      listeners.click?.({ target });
    },
  };
}

function loadPage() {
  const burger = makeEl("BUTTON", { "aria-expanded": "false" });
  const drawer = makeEl("DIV", { "data-open": "false" });
  const drawerLink = makeEl("A");
  const drawerWrap = makeEl("DIV");
  const headerDemo = makeEl("A");
  const byId = { burger, drawer };
  const document = {
    documentElement: {
      offsetWidth: 0,
      classList: { add() {}, remove() {} },
      setAttribute() {},
    },
    getElementById: (id) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === ".nav-cta a" ? [headerDemo] : []),
  };
  const window = {
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {},
  };
  vm.runInNewContext(SOURCE, {
    window,
    document,
    localStorage: { getItem: () => null, setItem() {} },
    location: { hostname: "oxagen.sh", pathname: "/", search: "" },
  });
  const isOpen = () => drawer.attrs["data-open"] === "true";
  return { burger, drawer, drawerLink, drawerWrap, headerDemo, isOpen };
}

describe("oxagen.js phone menu", () => {
  it("opens and closes from the burger button", () => {
    const page = loadPage();
    page.burger.click();
    expect(page.isOpen()).toBe(true);
    expect(page.burger.attrs["aria-expanded"]).toBe("true");
    page.burger.click();
    expect(page.isOpen()).toBe(false);
    expect(page.burger.attrs["aria-expanded"]).toBe("false");
  });

  it("closes when the header's Get a demo is tapped", () => {
    const page = loadPage();
    page.burger.click();
    page.headerDemo.click();
    expect(page.isOpen()).toBe(false);
    expect(page.burger.attrs["aria-expanded"]).toBe("false");
  });

  it("closes on a link inside it and stays open on anything else", () => {
    const page = loadPage();
    page.burger.click();
    page.drawer.click(page.drawerWrap);
    expect(page.isOpen()).toBe(true);
    page.drawer.click(page.drawerLink);
    expect(page.isOpen()).toBe(false);
  });
});
