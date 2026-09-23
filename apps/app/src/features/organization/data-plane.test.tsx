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
    expect(plane()).toHaveTextContent("Acme Robotics is on Shared");
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
      "Outbound connections",
    ]) {
      expect(plane()).toHaveTextContent(fact);
    }
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
    expect(shown).toHaveTextContent(
      "partitioned by org_id, row-level policies enforced",
    );
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
    expect(shown).toHaveTextContent("db.acme.internal");
    expect(shown).toHaveTextContent("acme_tenant · schema 20260920");
    expect(
      within(modes()).getByRole("button", { name: "Dedicated · current" }),
    ).toHaveAttribute("aria-pressed", "true");
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
      expect(dialog).toHaveTextContent("nothing is sent");
    },
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
