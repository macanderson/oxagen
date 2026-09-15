// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../messages/en.json";
import { UNRECORDED, type UnrecordedKey } from "@/data/unrecorded";
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

  it("carries the backend gap as data only, and only where the row names one", () => {
    renderWithIntl(<NotRecorded section="run.frames_wrapped" />);
    expect(screen.getByTestId("not-recorded")).toHaveAttribute(
      "data-gap",
      "G6",
    );
    cleanup();
    renderWithIntl(<NotRecorded section="agents" />);
    expect(screen.getByTestId("not-recorded")).not.toHaveAttribute("data-gap");
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
