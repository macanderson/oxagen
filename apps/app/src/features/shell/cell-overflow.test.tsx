// @vitest-environment jsdom
// The whole value of a table cell whose text ends in an ellipsis: a pointer
// resting on it, or focus landing in its cell, shows the value in one tooltip,
// and a value that fits shows nothing. jsdom has no layout, so each case sets
// the widths a browser would measure.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { CellOverflow, clippedElement, OPEN_DELAY_MS } from "./cell-overflow";

const LONG =
  "Watches the release branch and cuts a tag when every required check passes";

/** Gives `node` the widths a browser measures for text cut at `clientWidth`. */
function measure(node: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(node, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(node, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
}

function page() {
  render(
    <>
      <div data-shell-page="">
        <table aria-label="Agents">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-testid="name">
                <a href="/agents/release-bot">release-bot</a>
              </td>
              <td data-testid="description">{LONG}</td>
            </tr>
            <tr>
              <td data-testid="owner">
                <div>
                  <span data-testid="owner-name">Mac Anderson</span>
                  <span>Platform team</span>
                </div>
              </td>
              <td>Short</td>
            </tr>
            <tr>
              <td>
                <span data-hover-card="" data-testid="carded">
                  {LONG}
                </span>
              </td>
              <td>
                <span title={LONG} data-testid="titled">
                  {LONG}
                </span>
              </td>
            </tr>
            <tr>
              <td colSpan={2} data-testid="spanning">
                {LONG}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <table aria-label="Grants">
        <thead>
          <tr>
            <th scope="col">Scope</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-testid="dialog-cell">{LONG}</td>
          </tr>
        </tbody>
      </table>
      <p data-testid="outside">{LONG}</p>
      <CellOverflow />
    </>,
  );
}

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("CellOverflow", () => {
  it("shows the whole value once the pointer rests on a cut cell", async () => {
    page();
    const description = screen.getByTestId("description");
    measure(description, 640, 320);
    fireEvent.pointerOver(description);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONG);
  });

  it("shows nothing for a value that fits its cell", async () => {
    page();
    const name = screen.getByTestId("name");
    measure(name, 120, 320);
    fireEvent.pointerOver(name);
    await pause(OPEN_DELAY_MS + 100);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the value at once when focus lands in a cut cell", async () => {
    page();
    const name = screen.getByTestId("name");
    measure(name, 400, 120);
    fireEvent.focusIn(screen.getByRole("link", { name: "release-bot" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "release-bot",
    );
  });

  it("hides the value when the pointer moves to a value that fits", async () => {
    page();
    const description = screen.getByTestId("description");
    measure(description, 640, 320);
    fireEvent.pointerOver(description);
    await screen.findByRole("tooltip");
    fireEvent.pointerOver(screen.getByText("Short"));
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });

  it("hides the value on Escape", async () => {
    page();
    const description = screen.getByTestId("description");
    measure(description, 640, 320);
    fireEvent.pointerOver(description);
    await screen.findByRole("tooltip");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});

describe("clippedElement", () => {
  it("takes the nearest cut element, not the whole cell", () => {
    page();
    const owner = screen.getByTestId("owner");
    const ownerName = screen.getByTestId("owner-name");
    measure(owner, 400, 200);
    measure(ownerName, 180, 90);
    expect(clippedElement(ownerName)).toBe(ownerName);
  });

  it("falls back to the cell when only the cell is cut", () => {
    page();
    const owner = screen.getByTestId("owner");
    const ownerName = screen.getByTestId("owner-name");
    measure(owner, 400, 200);
    measure(ownerName, 90, 90);
    expect(clippedElement(ownerName)).toBe(owner);
  });

  it("reads a table outside the page, such as one in a dialog", () => {
    page();
    const cell = screen.getByTestId("dialog-cell");
    measure(cell, 900, 300);
    expect(clippedElement(cell)).toBe(cell);
  });

  it("skips a value that has its own hover card or title", () => {
    page();
    const carded = screen.getByTestId("carded");
    const titled = screen.getByTestId("titled");
    measure(carded, 900, 300);
    measure(titled, 900, 300);
    expect(clippedElement(carded)).toBeNull();
    expect(clippedElement(titled)).toBeNull();
  });

  it("skips a cell that spans columns and text outside a table", () => {
    page();
    const spanning = screen.getByTestId("spanning");
    const outside = screen.getByTestId("outside");
    measure(spanning, 900, 300);
    measure(outside, 900, 300);
    expect(clippedElement(spanning)).toBeNull();
    expect(clippedElement(outside)).toBeNull();
  });
});
