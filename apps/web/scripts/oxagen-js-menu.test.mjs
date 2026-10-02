// The header island's menus in assets/oxagen.js, run against a stub page.
// The file is evaluated once in its own context, the way
// oxagen-js-drawer.test.mjs loads it, with the island, two top-level items,
// and timers the test advances by hand.
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
  const el = {
    tagName,
    attrs: { ...attrs },
    style: {
      props: {},
      setProperty(k, v) {
        this.props[k] = v;
      },
    },
    children: [],
    focused: false,
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    fire(type, event = {}) {
      listeners[type]?.({ target: el, ...event });
    },
    focus() {
      el.focused = true;
    },
    contains(node) {
      if (node === el) return true;
      return el.children.some((c) => c.contains(node));
    },
    closest() {
      return null;
    },
  };
  return el;
}

function loadPage({ currentIn = null } = {}) {
  const isl = makeEl("DIV");
  isl.getBoundingClientRect = () => ({ left: 100, top: 10 });
  const items = ["product", "company"].map((id) => {
    const item = makeEl("DIV", { "data-open": "false" });
    const btn = makeEl("BUTTON", { "aria-expanded": "false" });
    const link = makeEl("A");
    link.closest = (sel) => (sel === ".menu a" ? link : null);
    item.children.push(btn, link);
    item.querySelector = (sel) => {
      if (sel === ".nav-trigger") return btn;
      if (sel === 'a[aria-current="page"]') return currentIn === id ? link : null;
      return null;
    };
    return { id, item, btn, link };
  });
  isl.children.push(...items.map((i) => i.item));
  const outside = makeEl("MAIN");

  const docListeners = {};
  const document = {
    documentElement: {
      offsetWidth: 0,
      classList: { add() {}, remove() {} },
      setAttribute() {},
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === ".nav-isl" ? isl : null),
    querySelectorAll: (sel) => (sel === ".nav-item" ? items.map((i) => i.item) : []),
    addEventListener(type, fn) {
      docListeners[type] = fn;
    },
  };

  let nextId = 1;
  const timers = new Map();
  const window = {
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {},
  };
  vm.runInNewContext(SOURCE, {
    window,
    document,
    localStorage: { getItem: () => null, setItem() {} },
    location: { hostname: "oxagen.sh", pathname: "/", search: "" },
    setTimeout: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const flush = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
  };
  const [product, company] = items;
  const isOpen = (i) => i.item.attrs["data-open"] === "true";
  return { isl, product, company, outside, docListeners, flush, isOpen };
}

const mouse = { pointerType: "mouse" };

describe("oxagen.js island menus", () => {
  it("opens a menu from its button and closes it on a second click", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    expect(page.isOpen(page.product)).toBe(true);
    expect(page.product.btn.attrs["aria-expanded"]).toBe("true");
    page.product.btn.fire("click");
    expect(page.isOpen(page.product)).toBe(false);
    expect(page.product.btn.attrs["aria-expanded"]).toBe("false");
  });

  it("keeps one menu open at a time", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    page.company.btn.fire("click");
    expect(page.isOpen(page.product)).toBe(false);
    expect(page.isOpen(page.company)).toBe(true);
  });

  it("opens on mouse hover after a pause, and ignores touch", () => {
    const page = loadPage();
    page.product.item.fire("pointerenter", { pointerType: "touch" });
    page.flush();
    expect(page.isOpen(page.product)).toBe(false);
    page.product.item.fire("pointerenter", mouse);
    expect(page.isOpen(page.product)).toBe(false);
    page.flush();
    expect(page.isOpen(page.product)).toBe(true);
  });

  it("closes when the pointer leaves the island, unless it comes back", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    page.isl.fire("pointerleave", mouse);
    page.isl.fire("pointerenter", mouse);
    page.flush();
    expect(page.isOpen(page.product)).toBe(true);
    page.isl.fire("pointerleave", mouse);
    page.flush();
    expect(page.isOpen(page.product)).toBe(false);
  });

  it("closes on Escape and returns focus to the button", () => {
    const page = loadPage();
    page.company.btn.fire("click");
    page.docListeners.keydown({ key: "Tab" });
    expect(page.isOpen(page.company)).toBe(true);
    page.docListeners.keydown({ key: "Escape" });
    expect(page.isOpen(page.company)).toBe(false);
    expect(page.company.btn.focused).toBe(true);
  });

  it("closes on a click outside the island and stays open on one inside", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    page.docListeners.click({ target: page.product.btn });
    expect(page.isOpen(page.product)).toBe(true);
    page.docListeners.click({ target: page.outside });
    expect(page.isOpen(page.product)).toBe(false);
  });

  it("closes when focus leaves the island", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    page.isl.fire("focusout", { relatedTarget: page.company.btn });
    expect(page.isOpen(page.product)).toBe(true);
    page.isl.fire("focusout", { relatedTarget: page.outside });
    expect(page.isOpen(page.product)).toBe(false);
  });

  it("closes when a link inside the menu is followed", () => {
    const page = loadPage();
    page.product.btn.fire("click");
    page.product.item.fire("click", { target: page.product.link });
    expect(page.isOpen(page.product)).toBe(false);
  });

  it("moves the glow to the cursor, in the island's own coordinates", () => {
    const page = loadPage();
    page.isl.fire("pointermove", { clientX: 340, clientY: 40 });
    expect(page.isl.style.props["--mx"]).toBe("240px");
    expect(page.isl.style.props["--my"]).toBe("30px");
  });

  it("marks the section that holds the current page", () => {
    const page = loadPage({ currentIn: "company" });
    expect(page.company.item.attrs["data-current"]).toBe("");
    expect("data-current" in page.product.item.attrs).toBe(false);
  });
});
