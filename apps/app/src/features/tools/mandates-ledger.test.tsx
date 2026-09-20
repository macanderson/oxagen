// @vitest-environment jsdom
// The Tools mandates ledger rendered on its own, for the one claim the page
// suite cannot make from inside the Tools shell: where a row's mandate id
// goes. `tools.test.tsx` renders the whole page and asserts what each row
// prints; this file asserts the route the row opens, and the two states that
// have no row to open — the empty ledger and a read that failed.
//
// Rendered directly rather than through `Tools`, because the link is a
// property of the section and its `at`, and threading a second workspace
// through the page to prove the path is built from `at` and not from a
// constant would say less. The grant dialog is not under test here, so the
// ledger is drawn with no grant offered and the server action is mocked the
// way `grant-mandate.test.tsx` mocks it.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./grant-actions", () => ({ grantMandate: vi.fn() }));

const { MandatesLedger } = await import("./mandates-ledger");

const at = { org: "acme", ws: "core-platform" };

function draw(
  read: Parameters<typeof MandatesLedger>[0]["read"],
  orgRole: Parameters<typeof MandatesLedger>[0]["orgRole"] = "billing",
): void {
  render(
    <IntlProvider>
      <MandatesLedger read={read} orgRole={orgRole} at={at} grant={null} />
    </IntlProvider>,
  );
}

const ledger = () => screen.getByRole("region", { name: "Mandates ledger" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tools › mandates ledger › the row's link", () => {
  // The id was plain text here while the Agents tab already linked the same
  // id, so the office this ledger is written for could read a row and not
  // open it (#2957).
  it("opens the mandate's own page from the id", () => {
    draw(mandateList([mandateRow()]));
    const link = within(ledger()).getByRole("link", { name: "mnd_4f2a9c" });
    expect(link).toHaveAttribute(
      "href",
      routes.mandate(at.org, at.ws, "mnd_4f2a9c"),
    );
  });

  // `MandateRow.id` is the public id `get_mandate` takes, so the path is the
  // row's own id and not the first row's repeated.
  it("gives each row its own id in the path", () => {
    draw(
      mandateList([
        mandateRow(),
        mandateRow({ id: "mnd_91b37e", agentSlug: "release-bot" }),
      ]),
    );
    expect(
      within(ledger())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      routes.mandate(at.org, at.ws, "mnd_4f2a9c"),
      routes.mandate(at.org, at.ws, "mnd_91b37e"),
    ]);
  });

  // The path is built from the `at` the page hands down, so a ledger read in
  // a second workspace links into that workspace and not into a constant.
  it("links into the workspace the section was given", () => {
    render(
      <IntlProvider>
        <MandatesLedger
          read={mandateList([mandateRow()])}
          orgRole="billing"
          at={{ org: "globex", ws: "payments" }}
          grant={null}
        />
      </IntlProvider>,
    );
    expect(
      within(ledger()).getByRole("link", { name: "mnd_4f2a9c" }),
    ).toHaveAttribute(
      "href",
      routes.mandate("globex", "payments", "mnd_4f2a9c"),
    );
  });
});

describe("Tools › mandates ledger › the states with no row", () => {
  it("offers no link when the workspace has recorded no mandate", () => {
    draw(mandateList([]));
    expect(within(ledger()).getByText(/recorded no mandate/)).toHaveAttribute(
      "data-state",
      "empty",
    );
    expect(within(ledger()).queryByRole("link")).toBeNull();
    expect(within(ledger()).queryByRole("table")).toBeNull();
  });

  it("names the refusal and offers no link when the read is denied", () => {
    draw({ ok: false, reason: "denied", permission: "org.billing" });
    expect(within(ledger()).getByText(/org\.billing/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
    expect(within(ledger()).queryByRole("link")).toBeNull();
  });

  it("names the code and offers no link when the read failed", () => {
    draw(readError("mandate_ledger_unavailable", 503));
    expect(
      within(ledger()).getByText(/mandate_ledger_unavailable/),
    ).toHaveAttribute("data-reason", "error");
    expect(within(ledger()).queryByRole("link")).toBeNull();
  });
});
