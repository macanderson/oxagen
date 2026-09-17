// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../messages/en.json";
import {
  UNRECORDED,
  type UnrecordedKey,
  unrecordedRow,
} from "@/data/unrecorded";
import { NotRecorded } from "./not-recorded";

afterEach(async () => {
  // INV-26: the NotRecorded state is checked by axe in each test.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderWithIntl(element: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {element}
    </NextIntlClientProvider>,
  );
}

const keys = Object.keys(UNRECORDED).filter((key): key is UnrecordedKey =>
  Object.hasOwn(UNRECORDED, key),
);

describe("NotRecorded", () => {
  it.each(keys)("renders the catalog prose for %s", (section) => {
    renderWithIntl(<NotRecorded section={section} />);
    const state = screen.getByTestId("not-recorded");
    expect(state).toHaveAttribute("data-section", section);
    expect(state.textContent).toMatch(/not recorded/);
    expect(state).not.toHaveTextContent(/\bG\d+\b/);
    expect(state).not.toHaveTextContent(/milestone/i);
  });

  // The table only shrinks, so this asserts the rule over whatever rows it
  // still holds rather than naming a row a lane has since deleted: the gap is
  // carried as data where the row names one, and nowhere else.
  it.each(keys)("carries %s's backend gap as data only", (section) => {
    renderWithIntl(<NotRecorded section={section} />);
    const state = screen.getByTestId("not-recorded");
    const { gap } = unrecordedRow(section);
    if (gap === null) expect(state).not.toHaveAttribute("data-gap");
    else expect(state).toHaveAttribute("data-gap", gap);
    cleanup();
  });

  it("has prose in the catalog for every row and no row without prose", () => {
    const prose: Record<string, unknown> = en.unrecorded;
    const flat = new Set<string>();
    const walk = (node: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(node)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "string") flat.add(key);
        else if (typeof v === "object" && v !== null) walk({ ...v }, key);
      }
    };
    walk(prose, "");
    expect([...flat].sort()).toEqual([...keys].sort());
  });
});
