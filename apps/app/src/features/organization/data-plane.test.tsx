// @vitest-environment jsdom
// Organization › Data plane (pages/organization.md §Data plane): the
// segmented control Shared, Dedicated and Behind the firewall with the
// recorded mode marked current and a preview note on the others, the mode's
// facts (what get_data_plane records, "not recorded" for the rest), Request a
// change of plane and Rotate keys as stubs that say what they would do,
// Retention, and Tenant isolation. Every render is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { DataPlane } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DataPlaneTab } from "./data-plane";
import { dataPlane, workspaceRow } from "./organization.builders";

afterEach(cleanup);

const workspaces = {
  workspaces: [
    workspaceRow(),
    workspaceRow({ id: "wrk_2", slug: "finops", namespace: "finops" }),
  ],
};

async function renderPlane(read: Read<DataPlane> = readOk(dataPlane())) {
  const view = render(
    <IntlProvider>
      <DataPlaneTab
        org="acme"
        orgName="Acme Robotics"
        read={read}
        workspaces={workspaces}
      />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}

const plane = () => screen.getByRole("region", { name: "Data plane" });
const modes = () => screen.getByRole("group", { name: "Deployment mode" });

describe("the segmented control", () => {
  it("marks the recorded mode current and pressed, and names the plane in the badge", async () => {
    await renderPlane();
    const shared = within(modes()).getByRole("button", {
      name: "Shared · current",
    });
    expect(shared).toHaveAttribute("aria-pressed", "true");
    expect(
      within(modes()).getByRole("button", { name: "Dedicated" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(modes()).getByRole("button", { name: "Behind the firewall" }),
    ).toBeInTheDocument();
    expect(plane()).toHaveTextContent("Acme Robotics is on shared");
  });

  it("previews another mode under a note and draws that mode's facts", async () => {
    await renderPlane();
    await userEvent.click(
      within(modes()).getByRole("button", { name: "Behind the firewall" }),
    );
    expect(document.querySelector("[data-plane-preview]")).toHaveTextContent(
      "Preview. This organization is on Shared, so these facts describe what Behind the firewall would be.",
    );
    for (const fact of [
      "Deployment",
      "Bundle version",
      "Bundle signature",
      "Containers",
      "Air-gapped mode",
      "Licence",
      "Next bundle",
    ]) {
      expect(plane()).toHaveTextContent(fact);
    }
    // Outbound connections is a table of its own, as the design draws it.
    const outbound = within(plane()).getByRole("table", {
      name: "Outbound connections in use",
    });
    expect(
      within(outbound)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Destination", "Why", "State"]);
    expect(outbound).toHaveTextContent("not recorded");
  });
});

describe("the mode's facts", () => {
  it("fills the shared plane's binding and Postgres rows and says not recorded for the rest", async () => {
    await renderPlane();
    const shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    if (shown === null) throw new Error("no facts shown");
    for (const fact of [
      "Binding",
      "Postgres",
      "Object storage",
      "Key-encryption key",
      "Attester key",
      "Gateway",
    ]) {
      expect(shown).toHaveTextContent(fact);
    }
    // Row-level security on org_id is what the store has; no tenant table
    // is partitioned by org_id, so the fact never says partitioned.
    expect(shown).toHaveTextContent("row-level security on org_id, enforced");
    expect(shown).not.toHaveTextContent("partitioned");
    expect(
      shown.querySelector("[data-plane-status='active']"),
    ).toHaveTextContent("active");
    expect(shown.querySelectorAll("[data-not-recorded]")).toHaveLength(4);
  });

  it("prints a dedicated plane's host and database as recorded", async () => {
    await renderPlane(
      readOk(
        dataPlane({
          mode: "dedicated",
          host: "db.acme.internal",
          database: "acme_tenant",
          schemaVersion: "20260920",
        }),
      ),
    );
    const shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    expect(shown).toHaveTextContent("Tenant data in Postgres");
    expect(shown).toHaveTextContent(
      "db.acme.internal / acme_tenant · schema 20260920",
    );
    expect(shown).toHaveTextContent(
      "Identity and billing in Postgresstay on the shared plane by design",
    );
    expect(shown).not.toHaveTextContent("Postgres host");
    expect(
      within(modes()).getByRole("button", { name: "Dedicated · current" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it.each<[DataPlane["status"], string]>([
    ["degraded", "degraded"],
    ["disabled", "disabled"],
  ])(
    "badges a %s plane with the status recorded, never active (negative)",
    async (status, word) => {
      await renderPlane(readOk(dataPlane({ status })));
      const shown = document.querySelector<HTMLElement>("[data-plane-shown]");
      const badge = shown?.querySelector("[data-plane-status]");
      expect(badge).toHaveAttribute("data-plane-status", status);
      expect(badge).toHaveTextContent(word);
      expect(shown).not.toHaveTextContent(/\bactive\b/);
    },
  );

  it("prints when the binding was verified and rotated, and says verification is not recorded when it never was", async () => {
    await renderPlane(
      readOk(
        dataPlane({
          lastVerifiedAt: "2026-09-20T08:00:00.000Z",
          rotatedAt: "2026-09-01T08:00:00.000Z",
        }),
      ),
    );
    let shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    expect(shown).toHaveTextContent("verified");
    expect(shown).toHaveTextContent("credentials rotated");
    expect(shown?.querySelectorAll("time")).toHaveLength(2);
    cleanup();

    await renderPlane();
    shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    expect(shown).toHaveTextContent("verification not recorded");
    expect(shown).not.toHaveTextContent("credentials rotated");
  });

  it("prints only the parts of a dedicated binding that are recorded (negative)", async () => {
    await renderPlane(
      readOk(dataPlane({ mode: "dedicated", host: "db.acme.internal" })),
    );
    let shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    expect(shown).toHaveTextContent("db.acme.internal");
    expect(shown).not.toHaveTextContent("db.acme.internal /");
    expect(shown).not.toHaveTextContent("schema");
    cleanup();

    // A dedicated plane with neither host nor database says not recorded
    // rather than printing an empty endpoint.
    await renderPlane(readOk(dataPlane({ mode: "dedicated" })));
    shown = document.querySelector<HTMLElement>("[data-plane-shown]");
    const tenant = [...(shown?.querySelectorAll("dt") ?? [])].find(
      (dt) => dt.textContent === "Tenant data in Postgres",
    );
    expect(tenant?.nextElementSibling).toHaveTextContent(/^not recorded/);
  });

  it("says why the binding is missing when the read failed, and keeps Retention and Tenant isolation (negative)", async () => {
    await renderPlane(readError("control_plane_unavailable", 503));
    expect(screen.getByText(/control_plane_unavailable/)).toHaveAttribute(
      "data-reason",
      "error",
    );
    expect(screen.queryByRole("group", { name: "Deployment mode" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Retention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Tenant isolation" }),
    ).toBeInTheDocument();
  });
});

describe("the two writes", () => {
  it.each([
    ["Request a change of plane", "data-plane-request", "set_data_plane"],
    ["Rotate keys", "data-plane-rotate", "Audit under Keys"],
  ])(
    "%s opens a dialog that says what it would do and that nothing is sent",
    async (label, testId, says) => {
      await renderPlane();
      await userEvent.click(
        within(plane()).getByRole("button", { name: label }),
      );
      const dialog = await screen.findByTestId(testId);
      expect(dialog).toHaveTextContent(says);
      // The design's header close sits beside the title.
      expect(dialog.querySelector("[data-header-close]")).not.toBeNull();
      expect(dialog).toHaveTextContent("nothing is sent");
    },
  );
});

it("titles the plane request as the design does", async () => {
  await renderPlane();
  await userEvent.click(
    within(plane()).getByRole("button", { name: "Request a change of plane" }),
  );
  const dialog = await screen.findByTestId("data-plane-request");
  expect(within(dialog).getByRole("heading")).toHaveTextContent(
    /^Request a change of data plane$/,
  );
});

describe("Retention and Tenant isolation", () => {
  it("lists the five retention rows, none of which a contract records yet", async () => {
    await renderPlane();
    const retention = screen.getByRole("region", { name: "Retention" });
    for (const row of [
      "Frame bodies",
      "Run ledger",
      "Frame rows",
      "Control-plane audit",
      "digest_only mode",
    ]) {
      expect(retention).toHaveTextContent(row);
    }
    expect(retention.querySelectorAll("[data-not-recorded]")).toHaveLength(5);
  });

  it("states the five isolation guarantees and names every workspace scoped", async () => {
    await renderPlane();
    const isolation = screen.getByRole("region", { name: "Tenant isolation" });
    expect(isolation).toHaveTextContent("postgres · acme");
    for (const row of [
      "Rows",
      "Workspace scoping",
      "Cross-tenant reads",
      "Platform catalogs",
      "Startup guard",
    ]) {
      expect(isolation).toHaveTextContent(row);
    }
    expect(isolation).toHaveTextContent("(core-platform, finops)");
  });
});
