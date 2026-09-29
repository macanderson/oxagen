// @vitest-environment jsdom
// The whole value of text that ends in an ellipsis, in a table cell or marked
// `data-truncate`: a pointer resting on it, or focus landing on it, shows the
// value in one hover card, and a value that fits shows nothing. jsdom has no layout, so each case sets
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
import {
  CellOverflow,
  clippedElement,
  markCutCells,
  OPEN_DELAY_MS,
} from "./cell-overflow";

const LONG =
  "Watches the release branch and cuts a tag when every required check passes";

const GIVEN = "run_01J9Z3K4Q2W8XYV5T6R7S8P9M0";

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
                <a href="#release-bot">release-bot</a>
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
            <tr>
              <td data-testid="holder">
                <span data-truncate="" data-testid="cell-marked">
                  {LONG}
                </span>
              </td>
              <td>Fits</td>
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
      <p data-truncate="" data-testid="marked">
        {LONG}
      </p>
      <code data-truncate={GIVEN} data-testid="given">
        run_01J9Z3K4
      </code>
      <button type="button">
        <span data-truncate="" data-testid="in-button">
          {LONG}
        </span>
      </button>
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

  it("shows the value an element marked outside a table gives", async () => {
    page();
    const given = screen.getByTestId("given");
    measure(given, 640, 320);
    fireEvent.pointerOver(given);
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent(GIVEN);
    expect(card).toHaveAttribute("data-slot", "hover-card-content");
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

  it("shows a cut plain-text value when the keyboard reaches its cell", async () => {
    page();
    const description = screen.getByTestId("description");
    measure(description, 640, 320);
    markCutCells(document);
    expect(description).toHaveAttribute("tabindex", "0");
    fireEvent.focusIn(description);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONG);
  });

  it("shows a cut titled value to focus, since the browser shows its title only to a pointer", async () => {
    page();
    const titled = screen.getByTestId("titled");
    measure(titled, 900, 300);
    fireEvent.focusIn(titled);
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent(LONG);
    expect(card).toHaveAttribute("data-slot", "hover-card-content");
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

  it("shows a titled value to focus, which the browser gives nothing", () => {
    page();
    const titled = screen.getByTestId("titled");
    measure(titled, 900, 300);
    expect(clippedElement(titled, true)).toBe(titled);
  });

  it("takes marked text outside a table only while it is cut", () => {
    page();
    const marked = screen.getByTestId("marked");
    expect(clippedElement(marked)).toBeNull();
    measure(marked, 900, 300);
    expect(clippedElement(marked)).toBe(marked);
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

describe("markCutCells", () => {
  it("gives a cut cell a keyboard stop and takes it back once the value fits", () => {
    page();
    const description = screen.getByTestId("description");
    measure(description, 640, 320);
    markCutCells(document);
    expect(description).toHaveAttribute("tabindex", "0");
    measure(description, 300, 320);
    markCutCells(document);
    expect(description).not.toHaveAttribute("tabindex");
  });

  it("leaves a cell that holds a link to the link's own stop", () => {
    page();
    const name = screen.getByTestId("name");
    measure(name, 400, 120);
    markCutCells(document);
    expect(name).not.toHaveAttribute("tabindex");
  });

  it("gives a cut marked line outside a table a stop and takes it back once it fits", () => {
    page();
    const marked = screen.getByTestId("marked");
    measure(marked, 900, 300);
    markCutCells(document);
    expect(marked).toHaveAttribute("tabindex", "0");
    measure(marked, 300, 300);
    markCutCells(document);
    expect(marked).not.toHaveAttribute("tabindex");
  });

  it("leaves a marked value in a cell to the cell's one stop", () => {
    page();
    const holder = screen.getByTestId("holder");
    const inCell = screen.getByTestId("cell-marked");
    measure(inCell, 900, 300);
    markCutCells(document);
    expect(holder).toHaveAttribute("tabindex", "0");
    expect(inCell).not.toHaveAttribute("tabindex");
  });

  it("gives no stop to a marked value inside a control", () => {
    page();
    const inButton = screen.getByTestId("in-button");
    measure(inButton, 900, 300);
    markCutCells(document);
    expect(inButton).not.toHaveAttribute("tabindex");
  });

  it("reads a cut value nested in a cell that fits", () => {
    page();
    const owner = screen.getByTestId("owner");
    measure(screen.getByTestId("owner-name"), 180, 90);
    markCutCells(document);
    expect(owner).toHaveAttribute("tabindex", "0");
    expect(clippedElement(owner)).toBe(owner);
  });
});

describe("CellOverflow keyboard stops", () => {
  it("measures a row again when a paged table shows it", async () => {
    page();
    const description = screen.getByTestId("description");
    const row = description.closest("tr");
    if (row === null) throw new Error("the description cell has no row");
    measure(description, 640, 320);
    row.style.display = "none";
    row.style.display = "";
    await waitFor(() => {
      expect(description).toHaveAttribute("tabindex", "0");
    });
  });

  it("gives a stop to a cut line a growing transcript adds later", async () => {
    page();
    const transcript = document.createElement("div");
    document.body.append(transcript);
    const line = document.createElement("div");
    line.setAttribute("data-truncate", LONG);
    line.textContent = LONG;
    measure(line, 900, 300);
    transcript.append(line);
    await waitFor(() => {
      expect(line).toHaveAttribute("tabindex", "0");
    });
    transcript.remove();
  });
});
