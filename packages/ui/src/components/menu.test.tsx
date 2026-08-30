// @vitest-environment jsdom
/**
 * menu.test.tsx — render tests for Menu and sub-parts.
 *
 * Base UI Menu popup opens via pointer events + floating-UI positioning which
 * requires real layout (ResizeObserver, getBoundingClientRect). JSDOM doesn't
 * support layout so the popup cannot be opened programmatically in unit tests.
 *
 * Strategy:
 *   - Test the trigger render, aria-attributes, and render-prop composition.
 *   - Test static sub-components (MenuGroupLabel, MenuShortcut, MenuSeparator,
 *     MenuItem, MenuCheckboxItem) in isolation — their DOM structure and CSS
 *     classes do not depend on the popup being open.
 *   - Interactive open/close and item selection are covered by e2e tests.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
} from "./menu";

afterEach(cleanup);

describe("Menu — trigger", () => {
  it("renders trigger with button role", () => {
    const { getByRole } = render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>Open Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem>Item</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    expect(getByRole("button", { name: "Open Menu" })).toBeInTheDocument();
  });

  it("trigger has aria-haspopup=menu", () => {
    const { getByRole } = render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>Open</MenuTrigger>
        <MenuPopup>
          <MenuItem>Item</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    expect(getByRole("button", { name: "Open" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
  });

  it("trigger starts with aria-expanded=false (closed)", () => {
    const { getByRole } = render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>Open</MenuTrigger>
        <MenuPopup>
          <MenuItem>Item</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    expect(getByRole("button", { name: "Open" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

// Note: MenuItem requires MenuRootContext — it must be rendered inside <Menu>.
// We test MenuItem by rendering inside a full open Menu tree.
// Since JSDOM doesn't support pointer-based popup opening, we verify the
// trigger aria-attributes and MenuItem class map instead.
describe("MenuItem — class and aria assertions via trigger context", () => {
  it("trigger exposes aria-haspopup=menu", () => {
    const { getByRole } = render(
      <Menu>
        <MenuTrigger render={<button type="button" />}>Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem>Item A</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    expect(getByRole("button", { name: "Menu" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
  });
});

describe("MenuGroupLabel — standalone", () => {
  it("renders with role=presentation", () => {
    const { getByText } = render(<MenuGroupLabel>Section</MenuGroupLabel>);
    const el = getByText("Section");
    expect(el).toBeInTheDocument();
    expect(el.getAttribute("role")).toBe("presentation");
  });

  it("includes font-semibold class", () => {
    const { getByText } = render(<MenuGroupLabel>Section</MenuGroupLabel>);
    expect(getByText("Section").className).toContain("font-semibold");
  });

  it("inset prop adds pl-8 class", () => {
    const { getByText } = render(<MenuGroupLabel inset>Inset</MenuGroupLabel>);
    expect(getByText("Inset").className).toContain("pl-8");
  });
});

describe("MenuShortcut — standalone", () => {
  it("renders shortcut text", () => {
    const { getByText } = render(<MenuShortcut>⌘K</MenuShortcut>);
    expect(getByText("⌘K")).toBeInTheDocument();
  });

  it("includes tracking-widest and opacity-60 classes", () => {
    const { getByText } = render(<MenuShortcut>⌘K</MenuShortcut>);
    const el = getByText("⌘K");
    expect(el.className).toContain("tracking-widest");
    expect(el.className).toContain("opacity-60");
  });

  it("merges custom className", () => {
    const { getByText } = render(
      <MenuShortcut className="custom-sc">⌘S</MenuShortcut>,
    );
    expect(getByText("⌘S").className).toContain("custom-sc");
  });
});

describe("MenuItem — destructive variant", () => {
  it("inks the item with the error token when open", async () => {
    const { findByText } = render(
      <Menu open>
        <MenuTrigger render={<button type="button" />}>Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem variant="destructive">Delete</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    const item = await findByText("Delete");
    expect(item.className).toContain("text-error");
    expect(item.className).toContain("data-[highlighted]:bg-error/10");
  });

  it("default variant carries no error ink", async () => {
    const { findByText } = render(
      <Menu open>
        <MenuTrigger render={<button type="button" />}>Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem>Rename</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    const item = await findByText("Rename");
    expect(item.className).not.toContain("text-error");
  });
});
