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
//
// Two suites start from what `list_mandates` answers rather than from a view
// model, through the mapper the live adapter uses: a count whose unit is a
// currency code (#3130), and the stored status beside the window (#3152). The
// mapper's one import from `@oxagen/rules` is the legacy guess, and it throws
// here, so a row the page shows correctly was shown from the stored kind.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MandateList } from "@/data/contracts/mandates";
import { toMandateList } from "@/data/live/mappers/mandates";
import { readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  authorityOutput,
  mandateListOutput,
  mandateOutput,
} from "@/test/mandate-outputs";
import { mandateList, mandateRow } from "@/test/mandate-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./grant-actions", () => ({ grantMandate: vi.fn() }));
vi.mock("@oxagen/rules", () => ({
  legacyMeasureKindGuess: () => {
    throw new Error("the page guessed a measure kind from its unit");
  },
}));

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

/** What `list_mandates` answered, as the live adapter maps it. */
function fromRecord(
  out: Parameters<typeof toMandateList>[0],
): Parameters<typeof MandatesLedger>[0]["read"] {
  return readOk(MandateList.parse(toMandateList(out, 100)));
}

const rows = () => within(ledger()).getAllByTestId("mandate");
/** The ledger's one row, when the answer holds one mandate. */
const onlyRow = () => within(ledger()).getByTestId("mandate");

describe("Tools › mandates ledger › a count in a currency unit (#3130)", () => {
  // A tool may declare `{ type: "count", unit: "USD" }`, and the handler stamps
  // the limit `count` from that declaration. The mapper used to decide from
  // the unit's spelling, so 50 counted units printed as about $0.00 while the
  // gate enforced 50.
  it("prints the figures as whole units of USD, not as dollars", () => {
    draw(
      fromRecord(
        mandateListOutput([
          mandateOutput({
            limits: {
              seats: {
                perCall: "5",
                perPeriod: "50",
                period: "monthly",
                currencyOrUnit: "USD",
                kind: "count",
              },
            },
            authority: [
              authorityOutput({
                measure: "seats",
                currencyOrUnit: "USD",
                kind: "count",
                perCall: "5",
                perPeriod: "50",
                settled: "11",
                reserved: "1",
                remaining: "38",
              }),
            ],
          }),
        ]),
      ),
    );
    const row = onlyRow();
    const counts = within(row)
      .getAllByTestId("measure-count")
      .map((figure) => figure.textContent);
    // Per call, per period, settled, reserved and remaining, in that order.
    expect(counts).toEqual(["5 USD", "50 USD", "11 USD", "1 USD", "38 USD"]);
    expect(row.textContent).not.toContain("$");
  });

  // The other half: a declared amount in USD is still money.
  it("prints a declared amount in USD as dollars", () => {
    draw(fromRecord(mandateListOutput()));
    const row = onlyRow();
    expect(within(row).queryAllByTestId("measure-count")).toEqual([]);
    expect(row.textContent).toContain("$2,000.00");
  });
});

describe("Tools › mandates ledger › the status beside the window (#3152)", () => {
  // The sample answer is counted at 2026-09-16T12:00Z.
  const record = (overrides: Parameters<typeof mandateOutput>[0]) =>
    mandateOutput({ id: `mnd_${overrides?.status ?? "x"}`, ...overrides });

  it("keeps the stored word and says when an active mandate's window closed", () => {
    draw(
      fromRecord(
        mandateListOutput([record({ validTo: "2026-09-10T00:00:00.000Z" })]),
      ),
    );
    const row = onlyRow();
    const status = row.querySelector("[data-mandate-status]");
    expect(status).toHaveAttribute("data-mandate-status", "active");
    expect(status).toHaveAttribute("data-effect", "elapsed");
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).getByText(/^ended /).textContent).toContain(
      "Sep 10, 2026",
    );
  });

  it("says when a granted mandate starts", () => {
    draw(
      fromRecord(
        mandateListOutput([record({ validFrom: "2026-10-01T00:00:00.000Z" })]),
      ),
    );
    const row = onlyRow();
    expect(row.querySelector("[data-mandate-status]")).toHaveAttribute(
      "data-effect",
      "upcoming",
    );
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).getByText(/^starts /).textContent).toContain(
      "Oct 1, 2026",
    );
  });

  it("adds nothing while the window is open", () => {
    draw(fromRecord(mandateListOutput()));
    const row = onlyRow();
    expect(row.querySelector("[data-mandate-status]")).not.toHaveAttribute(
      "data-effect",
    );
    expect(within(row).queryByText(/^(starts|ended) /)).toBeNull();
  });

  // A draft past its dates is a request nobody granted, and an expired or
  // revoked row already says the window is shut.
  it("adds nothing to a requested, expired or revoked row, whatever its dates (negative)", () => {
    draw(
      fromRecord(
        mandateListOutput([
          record({
            status: "draft",
            grantedBy: null,
            roleAtGrant: null,
            validTo: "2026-09-10T00:00:00.000Z",
          }),
          record({ status: "expired", validTo: "2026-09-10T00:00:00.000Z" }),
          record({ status: "revoked", validFrom: "2026-10-01T00:00:00.000Z" }),
        ]),
      ),
    );
    for (const row of rows())
      expect(row.querySelector("[data-mandate-status]")).not.toHaveAttribute(
        "data-effect",
      );
    expect(within(ledger()).queryByText(/^(starts|ended) /)).toBeNull();
  });

  // The page and `list_mandates` must not disagree about what the record
  // holds: every row prints the status the record returned, the closed and
  // the not-yet-open windows included. Relabelling a row "expired" would have
  // traded the old contradiction for this one.
  it("prints every row's status as list_mandates returned it", () => {
    const out = mandateListOutput([
      record({ status: "active" }),
      record({ id: "mnd_closed", validTo: "2026-09-10T00:00:00.000Z" }),
      record({ id: "mnd_ahead", validFrom: "2026-10-01T00:00:00.000Z" }),
      record({ status: "draft", grantedBy: null, roleAtGrant: null }),
      record({ status: "expired" }),
      record({ status: "revoked" }),
    ]);
    draw(fromRecord(out));
    const words = {
      draft: "requested",
      active: "active",
      expired: "expired",
      revoked: "revoked",
    } as const;
    expect(
      rows().map((row) => [
        row.getAttribute("data-status"),
        row.querySelector("[data-mandate-status] > span")?.textContent,
      ]),
    ).toEqual(out.items.map((item) => [item.status, words[item.status]]));
  });
});
