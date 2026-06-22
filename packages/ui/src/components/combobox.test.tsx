// @vitest-environment jsdom
/**
 * combobox.test.tsx — render tests for Combobox and sub-parts.
 *
 * Covers: coss naming (ComboboxPopup not ComboboxContent), trigger size variants,
 * ComboboxValue placeholder, popup opens on click with search input and items.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
} from "./combobox";

afterEach(cleanup);

// Base UI portals the popup and marks it `pointer-events: none` during its entry
// animation; in jsdom that animation never resolves, so user-event's default
// pointer-events guard blocks typing into the (genuinely interactive) search
// input. Disable the guard for the search interactions — it is a jsdom artifact,
// not a real-browser one.
const user = userEvent.setup({ pointerEventsCheck: 0 });

const FRUITS = ["Apple", "Banana", "Cherry", "Durian"];

function TestCombobox({ size }: { size?: "sm" | "default" | "lg" }) {
  return (
    <Combobox>
      <ComboboxTrigger size={size}>
        <ComboboxValue placeholder="Pick a fruit" />
      </ComboboxTrigger>
      <ComboboxPopup searchPlaceholder="Search fruits…">
        {FRUITS.map((f) => (
          <ComboboxItem key={f} value={f.toLowerCase()}>
            {f}
          </ComboboxItem>
        ))}
      </ComboboxPopup>
    </Combobox>
  );
}

describe("Combobox — trigger render", () => {
  it("renders a combobox trigger button", () => {
    const { getByRole } = render(<TestCombobox />);
    expect(getByRole("combobox")).toBeInTheDocument();
  });

  it("shows placeholder text", () => {
    const { getByRole } = render(<TestCombobox />);
    expect(getByRole("combobox")).toHaveTextContent("Pick a fruit");
  });

  it("sm size trigger includes h-7 class", () => {
    const { getByRole } = render(<TestCombobox size="sm" />);
    expect(getByRole("combobox").className).toContain("h-7");
  });

  it("default size trigger includes h-8 class", () => {
    const { getByRole } = render(<TestCombobox size="default" />);
    expect(getByRole("combobox").className).toContain("h-8");
  });

  it("lg size trigger includes h-9 class", () => {
    const { getByRole } = render(<TestCombobox size="lg" />);
    expect(getByRole("combobox").className).toContain("h-9");
  });
});

describe("Combobox — popup opens and shows items", () => {
  it("opens popup on trigger click", async () => {
    const { getByRole, getByText } = render(<TestCombobox />);
    await user.click(getByRole("combobox"));
    expect(getByText("Apple")).toBeInTheDocument();
    expect(getByText("Banana")).toBeInTheDocument();
  });

  it("shows search input inside popup", async () => {
    const { getByRole, getByPlaceholderText } = render(<TestCombobox />);
    await user.click(getByRole("combobox"));
    expect(getByPlaceholderText("Search fruits…")).toBeInTheDocument();
  });

  it("renders all items in popup", async () => {
    const { getByRole, getByText } = render(<TestCombobox />);
    await user.click(getByRole("combobox"));
    for (const fruit of FRUITS) {
      expect(getByText(fruit)).toBeInTheDocument();
    }
  });
});

describe("Combobox — search/filter", () => {
  it("typing in search narrows the visible items (case-insensitive)", async () => {
    const { getByRole, getByText, queryByText, getByPlaceholderText } = render(
      <TestCombobox />,
    );
    await user.click(getByRole("combobox"));
    const searchInput = getByPlaceholderText("Search fruits…");
    await user.type(searchInput, "ban");
    // "Banana" matches, others should be filtered out of the list.
    expect(getByText("Banana")).toBeInTheDocument();
    expect(queryByText("Apple")).not.toBeInTheDocument();
    expect(queryByText("Cherry")).not.toBeInTheDocument();
    expect(queryByText("Durian")).not.toBeInTheDocument();
  });

  it("clearing the search restores all items", async () => {
    const { getByRole, getByText, getByPlaceholderText } = render(
      <TestCombobox />,
    );
    await user.click(getByRole("combobox"));
    const searchInput = getByPlaceholderText("Search fruits…");
    await user.type(searchInput, "app");
    // Partially filtered — only Apple visible.
    expect(getByText("Apple")).toBeInTheDocument();
    // Clear the search.
    await user.clear(searchInput);
    // All items restored.
    for (const fruit of FRUITS) {
      expect(getByText(fruit)).toBeInTheDocument();
    }
  });

  it("search is case-insensitive (uppercase query)", async () => {
    const { getByRole, getByText, queryByText, getByPlaceholderText } = render(
      <TestCombobox />,
    );
    await user.click(getByRole("combobox"));
    const searchInput = getByPlaceholderText("Search fruits…");
    await user.type(searchInput, "CHERRY");
    expect(getByText("Cherry")).toBeInTheDocument();
    expect(queryByText("Apple")).not.toBeInTheDocument();
  });

  it("no-match search shows no fruit items", async () => {
    const { getByRole, queryByText, getByPlaceholderText } = render(
      <TestCombobox />,
    );
    await user.click(getByRole("combobox"));
    const searchInput = getByPlaceholderText("Search fruits…");
    await user.type(searchInput, "zzz");
    for (const fruit of FRUITS) {
      expect(queryByText(fruit)).not.toBeInTheDocument();
    }
  });
});
