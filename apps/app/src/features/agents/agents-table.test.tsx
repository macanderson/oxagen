// @vitest-environment jsdom
// The Agents table drawn on its own (agents-table.tsx), for the rows the page
// test in agents.test.tsx does not draw: no operator, an operator with no name
// or a blank one, no key, no description, no spend basis, no mandate count,
// and a sort over columns where some rows hold nothing, which sort last in
// either direction, and the built-in assistant, which offers no action. Axe
// runs after every test (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { agentRow } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  retireAgent: vi.fn(),
  readAssignableRoles: vi.fn(() => new Promise(() => {})),
  readAgentRoleNames: vi.fn(() => new Promise(() => {})),
  assignAgentRole: vi.fn(),
}));

const { AgentsTable } = await import("./agents-table");

type Row = ReturnType<typeof agentRow>;

function renderTable(rows: Row[], first: boolean = false) {
  render(
    <IntlProvider>
      <AgentsTable
        rows={rows}
        org="acme"
        ws="core-platform"
        workspace="Core platform"
        more={null}
        first={first ? routes.agents("acme", "core-platform") : null}
      />
    </IntlProvider>,
  );
}

/** A row with its own id, slug and key, so several can share a table. */
function row(n: string, overrides: Partial<Row> = {}): Row {
  return agentRow({
    id: `agt_${n}`,
    slug: n,
    name: n,
    agentKey: `acme.core.${n}`,
    ...overrides,
  });
}

const rows = () => screen.getAllByTestId("agent-row");
const keysInOrder = () =>
  rows().map((r) => r.querySelector("a")?.getAttribute("href"));
const operations = () => {
  fireEvent.click(screen.getByRole("button", { name: "Operations" }));
};
const sortBy = (column: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Sort by ${column}` }));
};
const href = (slug: string) => routes.agent("acme", "core-platform", slug);

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AgentsTable › missing values", () => {
  it("says the owner and the purpose are not recorded when neither is (negative)", () => {
    renderTable([
      row("orphan", {
        operatorId: null,
        operatorName: null,
        description: null,
      }),
    ]);
    const [only] = rows();
    if (only === undefined) throw new Error("no row");
    expect(only).toHaveTextContent("not recorded");
    expect(only).not.toHaveTextContent("Marcus Bell");
  });

  it("draws an owner with no name by their id, and a blank name as a question mark", () => {
    renderTable([
      row("unnamed", { operatorId: "usr_quinn", operatorName: null }),
      row("blank", { operatorId: "usr_blank", operatorName: "   " }),
    ]);
    const [unnamed, blank] = rows();
    if (unnamed === undefined || blank === undefined)
      throw new Error("rows not drawn");
    expect(unnamed).toHaveTextContent("U");
    expect(blank).toHaveTextContent("?");
  });

  it("draws the owner's avatar when they set one, and their initials when they did not", () => {
    renderTable([
      row("pictured", {
        operatorAvatarUrl: "https://avatars.example.com/marcus.png",
      }),
      row("plain", { operatorAvatarUrl: null }),
    ]);
    const [pictured, plain] = rows();
    if (pictured === undefined || plain === undefined)
      throw new Error("rows not drawn");
    const image = within(pictured).getByTestId("operator-avatar");
    expect(image).toHaveAttribute("data-avatar", "image");
    expect(image).toHaveAttribute(
      "src",
      "https://avatars.example.com/marcus.png",
    );
    const initials = within(plain).getByTestId("operator-avatar");
    expect(initials).toHaveAttribute("data-avatar", "initials");
    expect(initials).toHaveTextContent("MB");
  });

  it("names a keyless row by its slug in the list and in its actions", () => {
    renderTable([
      row("keyless", { agentKey: null, mandates: null, description: null }),
    ]);
    operations();
    const [only] = rows();
    if (only === undefined) throw new Error("no row");
    expect(only.querySelector("a")).toHaveAttribute("href", href("keyless"));
    // The agent card has no key, and the sub line has no description.
    expect(only).toHaveTextContent("not recorded");
    expect(
      within(only).getByRole("button", { name: "Deregister" }),
    ).toBeInTheDocument();
  });

  // #4350: Deregister on the built-in assistant suspended the principal
  // stella acts through, and stella stopped answering in the workspace.
  it("offers the built-in assistant no action, only a managed badge (negative)", () => {
    renderTable([row("qa-chat", { managed: true }), row("release-bot")]);
    operations();
    const byHref = (slug: string) => {
      const found = rows().find(
        (r) => r.querySelector("a")?.getAttribute("href") === href(slug),
      );
      if (found === undefined) throw new Error(`no row for ${slug}`);
      return found;
    };
    const assistant = byHref("qa-chat");
    expect(
      within(assistant).queryByRole("button", { name: "Deregister" }),
    ).toBeNull();
    expect(within(assistant).queryByRole("link", { name: "Edit" })).toBeNull();
    expect(assistant.querySelector("[data-managed]")).toHaveTextContent(
      "managed by Oxagen",
    );
    expect(
      within(byHref("release-bot")).getByRole("button", { name: "Deregister" }),
    ).toBeInTheDocument();
  });

  it("says a spend figure's basis is not recorded, and a mandate count that was not read (negative)", () => {
    renderTable([
      row("unbased", {
        spend30d: { micros: "5000000", currency: "USD", basis: null },
        mandates: null,
      }),
    ]);
    operations();
    const [only] = rows();
    if (only === undefined) throw new Error("no row");
    expect(only).toHaveTextContent("$5.00");
    expect(only).toHaveTextContent("basis not recorded");
  });

  it("links the first page when this is a later one", () => {
    renderTable([row("a")], true);
    const nav = screen.getByRole("navigation", {
      name: "Agents beyond this page",
    });
    expect(
      within(nav).getByRole("link", { name: "First agents" }),
    ).toHaveAttribute("href", routes.agents("acme", "core-platform"));
    expect(within(nav).queryByRole("link", { name: "More agents" })).toBeNull();
  });
});

describe("AgentsTable › sorting", () => {
  it("sorts the agent column by key, and a keyless row by its slug", () => {
    renderTable([row("mike"), row("bravo", { agentKey: null }), row("zulu")]);
    sortBy("Agent");
    // "acme.core.mike" < "acme.core.zulu" < "bravo".
    expect(keysInOrder()).toEqual([href("mike"), href("zulu"), href("bravo")]);
  });

  it("sorts rows with no spend last in both directions", () => {
    renderTable([
      row("none-a", { spend30d: null }),
      row("low", {
        spend30d: { micros: "1000000", currency: "USD", basis: null },
      }),
      row("none-b", { spend30d: null }),
      row("high"),
    ]);
    operations();
    sortBy("Spend 30d");
    const ascending = keysInOrder();
    expect(ascending.slice(0, 2)).toEqual([href("low"), href("high")]);
    expect(ascending.slice(2).sort()).toEqual(
      [href("none-a"), href("none-b")].sort(),
    );
    sortBy("Spend 30d");
    const descending = keysInOrder();
    expect(descending.slice(0, 2)).toEqual([href("high"), href("low")]);
    expect(descending.slice(2).sort()).toEqual(
      [href("none-a"), href("none-b")].sort(),
    );
  });

  it("sorts a text column by its words", () => {
    renderTable([
      row("s", { status: "suspended" }),
      row("e", { status: "enrolled" }),
      row("u", { status: "unenrolled" }),
    ]);
    operations();
    sortBy("Status");
    expect(keysInOrder()).toEqual([href("e"), href("s"), href("u")]);
  });

  it("offers a tier facet that leaves out a row with no tier (negative)", () => {
    renderTable([
      row("a", { enforcementTier: "gateway" }),
      row("b", { enforcementTier: "harness" }),
      row("c", { enforcementTier: "gateway" }),
      row("d", { enforcementTier: null }),
    ]);
    operations();
    const tier = screen.getByRole("combobox", { name: "Filter by Tier" });
    expect(
      within(tier)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toHaveLength(3);
    fireEvent.change(tier, {
      target: {
        value: within(tier).getAllByRole("option")[1]?.getAttribute("value"),
      },
    });
    expect(rows().length).toBeLessThan(4);
  });
});
