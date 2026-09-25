// @vitest-environment jsdom
// The label the flyout sends beside the record's id. A page names the record
// it shows with `<PageRecord label>` (the Run page names its run), and the
// question asked there reaches ask_assistant with that name, so the agent can
// cite the record the way the person sees it.
//
// The label goes only with the id it names, and never past the contract's cap:
// a long label is cut, because refusing the turn would cost the person their
// question over a name.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";
import {
  ASSISTANT_ENTITY_LABEL_MAX,
  assistantPageContextSchema,
} from "@oxagen/oxagen/contracts/assistant.ask";
import { IntlProvider } from "@/test/intl";
import type { askAssistant as AskAssistantAction } from "./assistant-actions";
import { ENTITY_LABEL_MAX } from "./page-label";
import { PageRecord } from "./page-record";
import { ShellStateProvider, useShellState } from "./shell-state";

/** What the flyout hands the server action: the route, the id and the label. */
type SentInput = Parameters<typeof AskAssistantAction>[2];

const askAssistant =
  vi.fn<(org: string, ws: string, input: SentInput) => Promise<unknown>>();
vi.mock("./assistant-actions", () => ({ askAssistant }));

const pathname = vi.fn(() => "/acme/core-platform");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname().split("?")[0],
  useSearchParams: () => new URLSearchParams(pathname().split("?")[1] ?? ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

function OpenIt() {
  const { setAssistantOpen } = useShellState();
  return (
    <button
      type="button"
      onClick={() => {
        setAssistantOpen(true);
      }}
    >
      open assistant
    </button>
  );
}

/**
 * Ask one question from `url` with `page` rendered beside the chrome, where
 * the layout puts it, and answer the input the flyout sent.
 */
async function askFrom(url: string, page?: ReactNode) {
  pathname.mockReturnValue(url);
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AssistantFlyout />
      </ShellStateProvider>
      {page}
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  await user.type(screen.getByTestId("assistant-composer"), "why did it fail?");
  await user.click(screen.getByTestId("assistant-send"));
  await screen.findByTestId("assistant-answer");
  expect(askAssistant).toHaveBeenCalledTimes(1);
  const sent = askAssistant.mock.calls[0]?.[2];
  if (sent === undefined) throw new Error("the flyout sent nothing");
  return sent;
}

const RUN_URL = "/acme/core-platform/runs/arun_01k9";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  askAssistant.mockReset();
  askAssistant.mockResolvedValue({
    ok: true,
    value: {
      conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
      userMessageId: "6f1f5a8e-0000-4000-8000-00000000u001",
      assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a001",
      runId: "arun_01k9",
      reply: "The checkout test timed out.",
      parkedCards: [],
    },
  });
});
afterEach(cleanup);

describe("AssistantFlyout › the record's label", () => {
  it("sends the run's label from a run page, beside the run's id", async () => {
    const sent = await askFrom(
      RUN_URL,
      <PageRecord
        route="runs"
        id="arun_01k9"
        label="Fix the flaky checkout test"
      />,
    );
    expect(askAssistant).toHaveBeenCalledWith("acme", "core-platform", {
      conversationId: null,
      content: "why did it fail?",
      route: "runs",
      entityId: "arun_01k9",
      entityLabel: "Fix the flaky checkout test",
    });
    expect(sent.entityLabel).toBe("Fix the flaky checkout test");
  });

  it("sends no label when the page declared its record without one", async () => {
    const sent = await askFrom(
      "/acme/core-platform/spend?tab=findings&finding=fnd_014",
      <PageRecord route="spend" id="fnd_014" />,
    );
    expect(sent).toMatchObject({ route: "spend", entityId: "fnd_014" });
    expect(sent).not.toHaveProperty("entityLabel");
  });

  // The path names the record here, and a path carries no name.
  it("sends no label for a record read from the path with no declaration", async () => {
    const sent = await askFrom(RUN_URL);
    expect(sent).toMatchObject({ route: "runs", entityId: "arun_01k9" });
    expect(sent).not.toHaveProperty("entityLabel");
  });

  // A declaration can outlive its page for a render. Its label names the
  // record on the page that left, so it is not sent for the page that came.
  it("sends no label from a declaration another route left (negative)", async () => {
    const sent = await askFrom(
      RUN_URL,
      <PageRecord route="spend" id="fnd_014" label="Idle GPU reservation" />,
    );
    expect(sent).toMatchObject({ route: "runs", entityId: "arun_01k9" });
    expect(sent).not.toHaveProperty("entityLabel");
  });

  // The flyout drops an id past its cap, and a label with no id names
  // nothing the agent can look up.
  it("sends no label when the id it names was dropped (negative)", async () => {
    const sent = await askFrom(
      "/acme/core-platform/steering?tab=prs",
      <PageRecord route="steering" id={"p".repeat(257)} label="Long id" />,
    );
    expect(sent).toMatchObject({ route: "steering", entityId: null });
    expect(sent).not.toHaveProperty("entityLabel");
  });

  it("sends no label that is only whitespace (negative)", async () => {
    const sent = await askFrom(
      RUN_URL,
      <PageRecord route="runs" id="arun_01k9" label={"  \n\t "} />,
    );
    expect(sent).not.toHaveProperty("entityLabel");
  });

  // A harness title and a ledger task reference have no cap where they are
  // written, and a mandate's purpose runs to 2,000 characters. The contract
  // refuses a label past 256, so the flyout cuts one rather than lose the
  // person's question to a name.
  it("cuts an over-long label to the contract's cap, and the contract accepts it (over-long)", async () => {
    const sent = await askFrom(
      RUN_URL,
      <PageRecord route="runs" id="arun_01k9" label={"x".repeat(300)} />,
    );
    expect(sent.entityLabel).toBe(`${"x".repeat(ENTITY_LABEL_MAX - 1)}…`);
    expect(
      assistantPageContextSchema.safeParse({
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "core-platform",
        entityId: sent.entityId,
        entityLabel: sent.entityLabel,
      }).success,
    ).toBe(true);
  });

  it("never cuts between the two halves of a surrogate pair (over-long)", async () => {
    const sent = await askFrom(
      RUN_URL,
      <PageRecord
        route="runs"
        id="arun_01k9"
        label={`${"a".repeat(ENTITY_LABEL_MAX - 2)}\u{1f600}tail`}
      />,
    );
    expect(sent.entityLabel).toBe(`${"a".repeat(ENTITY_LABEL_MAX - 2)}…`);
  });

  it("holds the flyout's cap equal to the contract's", () => {
    expect(ENTITY_LABEL_MAX).toBe(ASSISTANT_ENTITY_LABEL_MAX);
  });
});
