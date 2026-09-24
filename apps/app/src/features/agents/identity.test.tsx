// @vitest-environment jsdom
// The Identity tab drawn on its own (identity.tsx), for the states the page
// test in agent.test.tsx does not reach: an identity with no key, principal,
// operator or first frame; a model tier the definition does not name or
// cannot be parsed for; a run credential that is revoked, never expires or
// was used; no credential at all; every host revoked; and a tamper figure
// that is zero or could not be read. Axe runs after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  agentDetail,
  committedDefinition,
  incident,
  incidentPage,
  runRow,
} from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  readCostCenters: vi.fn(),
  setAgentCostCenter: vi.fn(),
}));

const { IdentitySection } = await import("./identity");

type Props = ComponentProps<typeof IdentitySection>;
type Credential = AgentDetail["credentials"][number];
type Host = AgentDetail["hosts"][number];

const PLACE = { org: "acme", ws: "core-platform", agent: "release-bot" };
/** The instant the agent was read; every credential clock is judged against it. */
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

/** The builder's first row; a builder that returns none is a broken fixture. */
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("the builder returned no rows");
  return row;
}

const BASE_CREDENTIAL: Credential = first(agentDetail().credentials);
const BASE_HOST: Host = first(agentDetail().hosts);

function credential(overrides: Partial<Credential> = {}): Credential {
  return { ...BASE_CREDENTIAL, ...overrides };
}

function renderIdentity(overrides: Partial<Props> = {}) {
  const props: Props = {
    detail: agentDetail({ definition: committedDefinition() }),
    now: NOW,
    lastRun: runRow(),
    operatorName: "Marcus Bell",
    incidents: incidentPage([incident()]),
    wsName: "Core platform",
    wsSlug: "core-platform",
    place: PLACE,
    charge: null,
    ...overrides,
  };
  render(
    <IntlProvider>
      <IdentitySection {...props} />
    </IntlProvider>,
  );
}

const region = (name: string) => screen.getByRole("region", { name });

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Identity › facts", () => {
  it("says not recorded for a missing key, principal, operator and tier, and no frame yet (negative)", () => {
    renderIdentity({
      detail: agentDetail({
        identity: {
          agentKey: null,
          principalId: null,
          operatorId: null,
          firstFrameAt: null,
        },
      }),
      operatorName: null,
    });
    const facts = region("Identity");
    expect(facts).toHaveTextContent("Agent keynot recorded");
    expect(facts).toHaveTextContent("Principalnot recorded");
    expect(facts).toHaveTextContent("Model tiernot recorded");
    expect(facts).toHaveTextContent("Operatornot recorded");
    expect(facts).toHaveTextContent("First frameno frame yet");
    expect(region("Trust relationships")).toHaveTextContent(
      "Accountable humannot recorded",
    );
  });

  it("names the operator by id when no run names them", () => {
    renderIdentity({ operatorName: null });
    expect(region("Identity")).toHaveTextContent("Operatorusr_marcusbell");
    expect(region("Trust relationships")).toHaveTextContent(
      "Accountable humanusr_marcusbell",
    );
  });

  it.each([
    ["a file that names no tier", 'schema = "agent-definition/v0.1"\n'],
    ["a tier that is not a string", "model_tier = 3\n"],
    ["a file the parser refuses", "model_tier = [unterminated\n"],
  ])("says the model tier is not recorded for %s (negative)", (_, source) => {
    renderIdentity({
      detail: agentDetail({ definition: committedDefinition(source) }),
    });
    expect(region("Identity")).toHaveTextContent("Model tiernot recorded");
  });

  it("prints the cost center the identity is charged to, and offers the write when the viewer may make it", () => {
    renderIdentity({
      detail: agentDetail({ identity: { costCenter: "ENG-1001" } }),
      charge: {
        org: "acme",
        ws: "core-platform",
        agentSlug: "release-bot",
        agentName: "Release bot",
        costCenter: "ENG-1001",
      },
    });
    const facts = region("Identity");
    expect(facts).toHaveTextContent("Cost centerENG-1001");
    expect(
      within(facts).getByRole("button", { name: "Change cost center" }),
    ).toBeVisible();
  });

  it("says the cost center is inherited and offers no write without a charge target (negative)", () => {
    renderIdentity();
    const facts = region("Identity");
    expect(facts).toHaveTextContent("Inherited from the workspace");
    expect(
      within(facts).queryByRole("button", { name: "Change cost center" }),
    ).toBeNull();
  });
});

describe("Identity › run credential", () => {
  it("says the agent holds no long-lived credential when it has none (negative)", () => {
    renderIdentity({ detail: agentDetail({ credentials: [] }) });
    const run = region("Run credential");
    expect(run).toHaveTextContent("The agent holds no long-lived credential.");
    // The stub writes stay, so the operator can still read what is missing.
    expect(
      within(run).getByRole("button", { name: "Revoke credential" }),
    ).toBeVisible();
  });

  it("shows the newest live credential over a newer revoked one", () => {
    renderIdentity({
      detail: agentDetail({
        credentials: [
          credential({ id: "aky_old", prefix: "oxa_ag_01" }),
          credential({
            id: "aky_new",
            prefix: "oxa_ag_02",
            createdAt: "2026-09-10T10:00:00.000Z",
            revokedAt: "2026-09-11T10:00:00.000Z",
          }),
        ],
      }),
    });
    expect(region("Run credential")).toHaveTextContent("oxa_ag_01…");
  });

  it("falls back to the newest revoked credential when every one is revoked, and says so", () => {
    renderIdentity({
      detail: agentDetail({
        credentials: [
          credential({
            id: "aky_a",
            prefix: "oxa_ag_0a",
            revokedAt: "2026-09-05T10:00:00.000Z",
          }),
          credential({
            id: "aky_b",
            prefix: "oxa_ag_0b",
            createdAt: "2026-09-04T10:00:00.000Z",
            revokedAt: "2026-09-06T10:00:00.000Z",
          }),
        ],
      }),
    });
    const run = region("Run credential");
    expect(run).toHaveTextContent("oxa_ag_0b…");
    expect(run).toHaveTextContent("revoked");
  });

  it("prints when it was last used, that it never expires, and no issuee without an operator name", () => {
    renderIdentity({
      operatorName: null,
      detail: agentDetail({
        credentials: [
          credential({
            lastUsedAt: "2026-09-15T09:00:00.000Z",
            expiresAt: null,
          }),
        ],
      }),
    });
    const run = region("Run credential");
    expect(run).toHaveTextContent("Expiresdoes not expire");
    expect(run).not.toHaveTextContent("Last usednever");
    expect(
      within(run)
        .getAllByRole("time")
        .map((t) => t.getAttribute("datetime")),
    ).toContain("2026-09-15T09:00:00.000Z");
    expect(run).not.toHaveTextContent("to Marcus Bell");
  });

  it("names the issuee and says never used for a credential with no use", () => {
    renderIdentity();
    const run = region("Run credential");
    expect(run).toHaveTextContent("to Marcus Bell");
    expect(run).toHaveTextContent("Last usednever");
  });
});

describe("Identity › hosts", () => {
  it("says not enrolled for the device key and the runtime when every host is revoked (negative)", () => {
    renderIdentity({
      detail: agentDetail({
        hosts: [{ ...BASE_HOST, revokedAt: "2026-09-10T10:00:00.000Z" }],
      }),
    });
    expect(region("Run credential")).toHaveTextContent(
      "Host device keynot enrolled",
    );
    const trust = region("Trust relationships");
    expect(trust).toHaveTextContent("Runtimenot enrolled");
    expect(trust).toHaveTextContent("nothing signs its checkpoints yet");
  });

  it("names the live host's key and says it signs this agent's checkpoints", () => {
    renderIdentity();
    expect(region("Run credential")).toHaveTextContent(
      "signs checkpoints from build-01",
    );
    expect(region("Trust relationships")).toHaveTextContent(
      "its device key signs this agent’s checkpoints",
    );
  });
});

describe("Identity › trust relationships", () => {
  it("says replay is not recorded with no run, and the tamper figure is not recorded when incidents failed (negative)", () => {
    renderIdentity({
      lastRun: null,
      incidents: readError("tacho_unavailable", 503),
    });
    const trust = region("Trust relationships");
    expect(trust).toHaveTextContent("Replaynot recorded");
    expect(trust).toHaveTextContent("Tamper incidentsnot recorded");
    expect(within(trust).queryByRole("link", { name: "Read them" })).toBeNull();
  });

  it("says replay is not recorded when the newest run recorded no grade (negative)", () => {
    renderIdentity({ lastRun: runRow({ replayGrade: null }) });
    expect(region("Trust relationships")).toHaveTextContent(
      "Replaynot recorded",
    );
  });

  it("badges zero tamper incidents as clean, with no link to read them", () => {
    renderIdentity({
      incidents: incidentPage([incident({ kind: "telemetry_gap" })]),
    });
    const trust = region("Trust relationships");
    expect(trust).toHaveTextContent("Tamper incidents0");
    expect(within(trust).queryByRole("link", { name: "Read them" })).toBeNull();
  });
});
