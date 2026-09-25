// @vitest-environment jsdom
// The Run page names its run for the assistant. `<PageRecord>` carries the id
// the URL names and the title the header prints, so a question asked on the
// page reaches the turn with the run's label. The shell's component is swapped
// for one that draws its props where a test can read them. The real one draws
// nothing and writes the store the flyout reads, which
// `assistant-flyout.page-label.test.tsx` covers.
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOk } from "@/data/read";
import { IntlProvider } from "@/test/intl";
import {
  NOW,
  runDetail,
  runRow,
  runSource,
  runTranscript,
} from "./run.builders";

// jsdom has no layout, so it has no scrollIntoView; playback calls it.
Element.prototype.scrollIntoView = vi.fn();
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
vi.mock("../run-outcomes/actions", () => ({
  setRunOutcomesConsentAction: vi.fn(),
}));
vi.mock("../run-outcomes/provider-actions", () => ({
  loadRunIssueProviders: vi.fn(),
  authorizeRunIssues: vi.fn(),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  sealRun: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
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
const { Run } = await import("./run");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function declared(run: Parameters<typeof runRow>[0]) {
  const { source } = runSource({
    detail: readOk(runDetail({ run: runRow(run) })),
    transcript: readOk(runTranscript()),
  });
  const element = await Run({
    ctx,
    source,
    runId: "tse_7k2m9q",
    tab: null,
    kinds: null,
    frames: null,
    body: null,
    reads: null,
    spine: null,
    now: NOW,
  });
  await act(async () => {
    render(<IntlProvider>{element}</IntlProvider>);
    await Promise.resolve();
  });
  return screen.getByTestId("page-record");
}

afterEach(() => {
  cleanup();
});

describe("Run page › the record it declares", () => {
  it("names the run by the id the URL names and the name the header prints", async () => {
    const record = await declared({});
    expect(record).toHaveAttribute("data-route", "runs");
    expect(record).toHaveAttribute("data-id", "tse_7k2m9q");
    expect(record).toHaveAttribute("data-label", "Cut the 3.2 release branch");
  });

  it("falls back to the task reference when the run has no name, as the header does", async () => {
    const record = await declared({ name: null });
    expect(record).toHaveAttribute(
      "data-label",
      "ENG-4121 cut the 3.2 release",
    );
  });

  it("declares the id with no label when the run has neither (negative)", async () => {
    const record = await declared({ name: null, taskRef: null });
    expect(record).toHaveAttribute("data-id", "tse_7k2m9q");
    expect(record).not.toHaveAttribute("data-label");
  });

  it("declares the run on its empty state too", async () => {
    const record = await declared({ frames: 0 });
    expect(screen.getByTestId("run-empty")).toBeTruthy();
    expect(record).toHaveAttribute("data-label", "Cut the 3.2 release branch");
  });
});
