// @vitest-environment jsdom
// The mandate page names its mandate for the assistant. A mandate has no name,
// so `<PageRecord>` carries the id the URL names and the purpose the header
// prints under it. The shell's component is swapped for one that draws its
// props where a test can read them. The real one draws nothing and writes the
// store the flyout reads, which `assistant-flyout.page-label.test.tsx` covers.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { IntlProvider } from "@/test/intl";
import { mandateDetailRead, mandateRow } from "@/test/mandate-views";
import { mandateSource } from "./mandate.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  changeMandateLimits: vi.fn(),
  revokeMandate: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The rest of the shell's surface is the real one, so this file also proves
// the page's import of it loads.
vi.mock("@/features/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/shell")>()),
  PageRecord: (props: {
    route: string;
    id: string | null;
    label?: string | null;
  }) => (
    <span
      data-testid="page-record"
      data-route={props.route}
      data-id={props.id ?? undefined}
      data-label={props.label ?? undefined}
    />
  ),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Mandate } = await import("./mandate");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "a-intel",
  orgName: "Anderson Intelligence Corp.",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderMandate(read: Parameters<typeof mandateSource>[0]) {
  const { source } = mandateSource(read);
  const element = await Mandate({
    ctx,
    source,
    mandate: "mnd_4f2a9c",
    searchParams: {},
  });
  render(<IntlProvider>{element}</IntlProvider>);
}

afterEach(() => {
  cleanup();
});

describe("Mandate page › the record it declares", () => {
  it("names the mandate by the id the URL names and the purpose the header prints", async () => {
    await renderMandate(mandateDetailRead());
    const record = screen.getByTestId("page-record");
    expect(record).toHaveAttribute("data-route", "mandates");
    expect(record).toHaveAttribute("data-id", "mnd_4f2a9c");
    expect(record).toHaveAttribute(
      "data-label",
      "monthly infrastructure invoices, PO-4471",
    );
  });

  // A purpose runs to 2,000 characters, past what the turn accepts. The page
  // declares it whole, and the flyout cuts it before it sends one.
  it("declares a long purpose whole", async () => {
    const purpose = "Pay the vendor invoices. ".repeat(40).trim();
    await renderMandate(
      mandateDetailRead({ mandate: mandateRow({ purpose }) }),
    );
    expect(screen.getByTestId("page-record")).toHaveAttribute(
      "data-label",
      purpose,
    );
  });

  it("declares nothing when the mandate could not be read (negative)", async () => {
    await renderMandate(readError("ledger_unreachable", 502));
    expect(screen.queryByTestId("page-record")).toBeNull();
  });
});
