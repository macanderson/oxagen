// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  NOW,
  runDetail,
  runFrame,
  runRow,
  runSource,
  runTranscript,
  runWork,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";

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
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

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

afterEach(cleanup);

const started = runFrame({
  seq: "1",
  type: "run.started",
  summary: "Claude Code on mbp-marcus",
  observedAt: "2026-09-15T09:14:02.118Z",
});
const unknown = runFrame({
  seq: "2",
  type: "repo.unknown",
  summary: "github.com/acme/edge-proxy resolves to no workspace",
  observedAt: "2026-09-15T09:14:02.140Z",
});
const interject = runFrame({
  seq: "3",
  type: "control.interject",
  summary: "skills.enabled = true and no config resolves",
  observedAt: "2026-09-15T09:14:02.146Z",
});

async function renderRun(
  frames: ReturnType<typeof runFrame>[],
  transcript = runTranscript(),
  work?: Parameters<typeof runSource>[0]["work"],
) {
  const { source } = runSource({
    detail: readOk(
      runDetail({
        run: runRow({ name: "Cut the first release notes for edge-proxy" }),
        frames: { frames, cursor: null, more: false },
      }),
    ),
    transcript: readOk(transcript),
    ...(work === undefined ? {} : { work }),
  });
  const page = await Run({
    ctx,
    source,
    runId: "tse_7k2m9q",
    tab: null,
    zoom: null,
    kinds: null,
    frames: null,
    body: null,
    reads: null,
    spine: null,
    now: NOW,
  });
  return render(<IntlProvider>{page}</IntlProvider>);
}

describe("a run held on an interjection", () => {
  it("draws the header, the note and the three panes in order, with no header actions", async () => {
    const { container } = await renderRun([started, unknown, interject]);
    expect(screen.getByTestId("run-interjection")).toBeInTheDocument();
    expect(screen.queryByTestId("run-header")).toBeNull();
    expect(screen.queryByTestId("run-actions")).toBeNull();
    expect(screen.getByText("Run · tse_7k2m9q")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Cut the first release notes for edge-proxy",
      }),
    ).toBeInTheDocument();
    // The checkout was not captured, so the meta line says so in place of
    // the remote and commit.
    expect(screen.getByLabelText("Run facts")).toHaveTextContent(
      "acme.core.release-bot · Claude Code · Marcus Bell · harness tier · remote not captured",
    );
    expect(
      screen.getByText("paused · waiting on a person"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "The loop is stopped. Not failed, not queued, not continuing on a default. The harness is holding at the boundary before its first model call, the clock on this run is not running, and nothing has been charged since 09:14:02Z.",
    );
    const panes = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(panes).toEqual([
      "What the agent shows Marcus",
      "What Oxagen put to a person",
      "What was written down",
    ]);
    await expectNoAxe(container);
  });

  it("keeps Send this answer disabled until a pick, then names who it answers as and why it cannot send", async () => {
    await renderRun([started, unknown, interject]);
    const send = screen.getByRole("button", { name: "Send this answer" });
    expect(send).toBeDisabled();
    expect(screen.getByText("pick one")).toBeInTheDocument();
    const link = screen.getByRole("button", {
      name: /^Link it to core-platform/,
    });
    const create = screen.getByRole("button", {
      name: /^Create a new workspace/,
    });
    // Each card says what is not worked out rather than printing an
    // inheritance list nothing computed.
    expect(link).toHaveTextContent("not worked out yet (#3941)");
    expect(link).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(link);
    expect(link).toHaveAttribute("aria-pressed", "true");
    expect(create).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("answers as Marcus Bell")).toBeInTheDocument();
    expect(send).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Oxagen cannot send this answer yet.",
    );
  });

  it("names every unrecorded element in place rather than inventing it", async () => {
    await renderRun([started, unknown, interject]);
    const oxagen = screen.getByTestId("interjection-oxagen");
    expect(within(oxagen).getByText("the loop is held")).toBeInTheDocument();
    expect(
      within(oxagen).getByText("skills.enabled = true and no config resolves"),
    ).toBeInTheDocument();
    expect(
      within(oxagen).getByRole("heading", { name: "Link" }),
    ).toBeInTheDocument();
    expect(
      within(oxagen).getByRole("heading", { name: "Create" }),
    ).toBeInTheDocument();
    expect(
      within(oxagen).getByRole("heading", { name: "If nobody answers" }),
    ).toBeInTheDocument();
    expect(
      within(oxagen).getByText("No timeout is recorded on this interjection."),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("interjection-agent")
        .querySelector('[data-gap="interjection-question"]'),
    ).not.toBeNull();
  });

  it("prints the remote and commit the checkout recorded on the meta line", async () => {
    await renderRun(
      [started, unknown, interject],
      runTranscript(),
      readOk(runWork()),
    );
    expect(screen.getByTestId("interjection-remote")).toHaveTextContent(
      "github.com/acme/platform@a4c91e2",
    );
  });

  it("names the mid-run default and the Create path's name as not worked out", async () => {
    await renderRun([started, unknown, interject]);
    const oxagen = screen.getByTestId("interjection-oxagen");
    expect(within(oxagen).getByTestId("interjection-midrun")).toHaveTextContent(
      "#3941",
    );
    expect(oxagen).toHaveTextContent(
      "a workspace whose name is not proposed yet",
    );
  });

  it("lists the recorded frames and greys the ones that have not happened", async () => {
    await renderRun([started, unknown, interject]);
    const pane = screen.getByTestId("interjection-frames");
    expect(within(pane).getAllByTestId("interjection-frame")).toHaveLength(3);
    const pending = within(pane).getAllByTestId("interjection-frame-pending");
    expect(pending.map((row) => row.textContent)).toEqual([
      "control.answer Marcus answered · pending",
      "skills.resolved waits on the answer",
      "context.assembled waits on the answer",
      "model.request the first model call of the run has not happened",
    ]);
    expect(
      within(pane).getByText(
        "The three greyed frames have not happened. A run that is waiting is a run that has written down that it is waiting.",
      ),
    ).toBeInTheDocument();
  });

  it("reads live once the recording carries the answer, and draws no answer control", async () => {
    await renderRun([
      started,
      unknown,
      interject,
      runFrame({
        seq: "4",
        type: "control.answer",
        summary: "linked to core-platform",
        observedAt: "2026-09-15T09:17:38.902Z",
      }),
      runFrame({
        seq: "5",
        type: "skills.loaded",
        summary: "release-notes · 1,840 tokens",
        observedAt: "2026-09-15T09:17:39.000Z",
      }),
    ]);
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "Answered at 09:17:38Z. linked to core-platform",
    );
    expect(
      screen.queryByRole("button", { name: "Send this answer" }),
    ).toBeNull();
    expect(screen.queryAllByTestId("interjection-frame-pending")).toHaveLength(
      0,
    );
    expect(
      screen.getByRole("heading", { name: "Skill loaded" }),
    ).toBeInTheDocument();
  });

  it("draws an ordinary run as the ordinary run page", async () => {
    await renderRun([started, runFrame()]);
    expect(screen.queryByTestId("run-interjection")).toBeNull();
    expect(screen.getByTestId("run-header")).toBeInTheDocument();
  });

  it("opens the agent's pane on the operator's first message from the transcript", async () => {
    await renderRun(
      [started, unknown, interject],
      runTranscript({
        entries: [
          transcriptEntry({
            kind: "turn",
            kinds: ["prompt"],
            at: "2026-09-15T09:14:01.500Z",
            request: transcriptBody({
              text: "Cut the first release notes for edge-proxy.",
            }),
            response: null,
          }),
        ],
      }),
    );
    const prompt = screen.getByTestId("interjection-prompt");
    expect(prompt).toHaveTextContent("Marcus Bell");
    expect(prompt).toHaveTextContent(
      "Cut the first release notes for edge-proxy.",
    );
    expect(prompt).toHaveTextContent("09:14:01Z");
    expect(prompt.querySelector('[data-gap="interjection-prompt"]')).toBeNull();
  });

  it("says the operator's message is not on the record when no prompt body was kept", async () => {
    await renderRun([started, unknown, interject]);
    expect(
      screen
        .getByTestId("interjection-prompt")
        .querySelector('[data-gap="interjection-prompt"]'),
    ).toHaveTextContent("The operator's first message is not on the record.");
  });
});
