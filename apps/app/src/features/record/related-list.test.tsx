// @vitest-environment jsdom
// The related records list on its own: a card draws only the facts its record
// carries, a require effect reads differently from a forbid, and a search
// that matches nothing says so.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { type RelatedItem, RelatedList } from "./related-list";
import { recordLink } from "./view";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const item = (overrides: Partial<RelatedItem>): RelatedItem => ({
  lineage: "ctx.a.one",
  kind: "constraint",
  force: "must",
  constraintEffect: "forbid",
  scope: "workspace",
  statement: "Never push to main.",
  commit: "4d5e6f7a8b9c",
  publishedAt: "2026-09-12T09:16:40.000Z",
  href: recordLink({
    org: "acme",
    ws: "core-platform",
    lineage: "ctx.a.one",
  }),
  ...overrides,
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("RelatedList", () => {
  it("draws only the facts a record carries: no force, no effect, no commit and no date when it has none", () => {
    render(
      <IntlProvider>
        <RelatedList
          items={[
            item({
              lineage: "ctx.a.bare",
              kind: "fact",
              force: null,
              constraintEffect: null,
              commit: null,
              publishedAt: null,
            }),
          ]}
        />
      </IntlProvider>,
    );
    const card = screen.getByTestId("record-related-list");
    expect(card).toHaveTextContent("ctx.a.bare");
    expect(card).not.toHaveTextContent("must");
    expect(card).not.toHaveTextContent("4d5e6f7");
    expect(card).not.toHaveTextContent("2026");
  });

  it("reads a require effect apart from a forbid", () => {
    render(
      <IntlProvider>
        <RelatedList
          items={[
            item({ lineage: "ctx.a.req", constraintEffect: "require" }),
            item({ lineage: "ctx.a.forbid", constraintEffect: "forbid" }),
          ]}
        />
      </IntlProvider>,
    );
    const list = screen.getByTestId("record-related-list");
    expect(list).toHaveTextContent("require");
    expect(list).toHaveTextContent("forbid");
    expect(list).toHaveTextContent("4d5e6f7");
  });

  it("says nothing matches when a search hides every record (negative)", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <RelatedList items={[item({})]} />
      </IntlProvider>,
    );
    await user.type(
      screen.getByRole("searchbox", { name: "Search records" }),
      "nothing-like-this",
    );
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
    expect(screen.queryByTestId("record-related-list")).toBeNull();
  });
});
