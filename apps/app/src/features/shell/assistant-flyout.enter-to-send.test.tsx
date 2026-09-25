// @vitest-environment jsdom
// The flyout composer's keyboard send under the person's `enter_to_submit`
// preference (ADR-075). On, Enter sends and Shift+Enter adds a line. Off, Enter
// adds a line and Cmd+Enter or Ctrl+Enter sends. Under both, an Enter that
// commits an input method editor's word is left to the editor, and a key send
// is refused wherever the Send button's is: an empty draft, a turn in flight,
// and a draft over the limit. A line under the composer names the send key.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  ASSISTANT_CONTENT_MAX,
  openAssistantDraft,
} from "@/shared/assistant-draft";
import { ShellStateProvider, useShellState } from "./shell-state";

const askAssistant = vi.fn();
vi.mock("./assistant-actions", () => ({ askAssistant }));
// The engine read has its own file (assistant-flyout.engine-health.test.tsx).
// Here it never answers, so nothing but a turn in flight holds Send.
vi.mock("./engine-actions", () => ({
  readAssistantEngine: () => new Promise(() => undefined),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
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

/** Open the flyout with the preference as the shell would pass it, or not at all. */
async function openFlyout(enterToSubmit?: boolean) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        {enterToSubmit === undefined ? (
          <AssistantFlyout />
        ) : (
          <AssistantFlyout enterToSubmit={enterToSubmit} />
        )}
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  const composer = screen.getByTestId("assistant-composer");
  return { user, composer, flyout: screen.getByTestId("assistant-flyout") };
}

const turn = {
  ok: true,
  value: {
    conversationId: "6f1f5a8e-0000-4000-8000-00000000c0de",
    userMessageId: "6f1f5a8e-0000-4000-8000-00000000u001",
    assistantMessageId: "6f1f5a8e-0000-4000-8000-00000000a001",
    runId: "arun_01k9",
    reply: "Three runs are live.",
    parkedCards: [],
  },
};

/** The one turn `askAssistant` was asked for, as the Send button asks it. */
function expectAsked(content: string) {
  expect(askAssistant).toHaveBeenCalledOnce();
  expect(askAssistant).toHaveBeenCalledWith("acme", "core-platform", {
    conversationId: null,
    content,
    route: "fleet",
    entityId: null,
  });
}

beforeAll(() => {
  // The flyout reads the `md` breakpoint as a store. jsdom has no matchMedia.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  askAssistant.mockReset();
  askAssistant.mockResolvedValue(turn);
});
afterEach(cleanup);

describe("AssistantFlyout with enter_to_submit on", () => {
  it("sends on Enter and clears the composer", async () => {
    const { user, composer, flyout } = await openFlyout(true);
    await user.type(composer, "what is live?{Enter}");

    expectAsked("what is live?");
    await waitFor(() => {
      expect(composer).toHaveValue("");
    });
    await expectNoAxe(flyout);
  });

  it("adds a line on Shift+Enter and sends nothing until Enter (negative)", async () => {
    const { user, composer } = await openFlyout(true);
    await user.type(composer, "first{Shift>}{Enter}{/Shift}second");

    expect(composer).toHaveValue("first\nsecond");
    expect(askAssistant).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expectAsked("first\nsecond");
  });

  it("sends nothing and adds no line on Enter in an empty composer (negative)", async () => {
    const { user, composer } = await openFlyout(true);
    await user.click(composer);
    await user.keyboard("{Enter}");

    expect(composer).toHaveValue("");
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("sends nothing on Enter while a turn is in flight, and keeps the draft (negative)", async () => {
    askAssistant.mockReturnValue(new Promise(() => undefined));
    const { user, composer } = await openFlyout(true);
    await user.type(composer, "first{Enter}");
    expect(composer).toBeDisabled();

    // A page's request lands in the composer while the first turn runs.
    act(() => {
      openAssistantDraft({
        org: "acme",
        ws: "core-platform",
        content: "second",
      });
    });
    expect(composer).toHaveValue("second");
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 13 });

    expect(askAssistant).toHaveBeenCalledOnce();
    expect(composer).toHaveValue("second");
  });

  it("sends nothing on Enter when the draft is over the limit (negative)", async () => {
    const { composer } = await openFlyout(true);
    fireEvent.change(composer, {
      target: { value: "x".repeat(ASSISTANT_CONTENT_MAX + 1) },
    });
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 13 });

    expect(askAssistant).not.toHaveBeenCalled();
  });
});

describe("AssistantFlyout with enter_to_submit off", () => {
  it("adds a line on Enter and sends nothing (negative)", async () => {
    const { user, composer } = await openFlyout(false);
    await user.type(composer, "first{Enter}second");

    expect(composer).toHaveValue("first\nsecond");
    expect(askAssistant).not.toHaveBeenCalled();
  });

  it("sends on Ctrl+Enter", async () => {
    const { user, composer } = await openFlyout(false);
    await user.type(composer, "what is live?{Control>}{Enter}{/Control}");

    expectAsked("what is live?");
  });

  it("sends on Cmd+Enter", async () => {
    const { user, composer } = await openFlyout(false);
    await user.type(composer, "what is live?{Meta>}{Enter}{/Meta}");

    expectAsked("what is live?");
  });

  it("sends nothing on Ctrl+Enter in an empty composer (negative)", async () => {
    const { user, composer } = await openFlyout(false);
    await user.click(composer);
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(askAssistant).not.toHaveBeenCalled();
  });

  // The column's default. A shell that passes no preference must not make
  // Enter a send the person never chose.
  it("is what the flyout does when the shell passes no preference", async () => {
    const { user, composer } = await openFlyout();
    await user.type(composer, "first{Enter}second");

    expect(composer).toHaveValue("first\nsecond");
    expect(askAssistant).not.toHaveBeenCalled();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expectAsked("first\nsecond");
  });
});

// One line under the composer names the send key for the setting, and the
// composer takes it as its description, so a screen reader hears it too.
describe("AssistantFlyout send hint", () => {
  const ENTER = "Enter to send, Shift+Enter for a new line";
  const MOD_ENTER = "Cmd+Enter or Ctrl+Enter to send, Enter for a new line";

  it("names Enter when enter_to_submit is on", async () => {
    const { composer } = await openFlyout(true);

    expect(screen.getByTestId("assistant-send-hint").textContent).toBe(ENTER);
    expect(composer).toHaveAccessibleDescription(ENTER);
  });

  it.each([false, undefined])(
    "names Cmd+Enter and Ctrl+Enter when enter_to_submit is %s",
    async (enterToSubmit) => {
      const { composer } = await openFlyout(enterToSubmit);

      expect(screen.getByTestId("assistant-send-hint").textContent).toBe(
        MOD_ENTER,
      );
      expect(composer).toHaveAccessibleDescription(MOD_ENTER);
    },
  );
});

// Japanese and Chinese input commit a word with Enter. That Enter belongs to
// the input method editor: it must neither send nor be prevented, or the word
// never lands. Chrome and Firefox mark it `isComposing`. Safari marks it only
// with keyCode 229.
describe.each([true, false])(
  "AssistantFlyout during IME composition (enter_to_submit %s)",
  (enterToSubmit) => {
    const send = enterToSubmit
      ? { key: "Enter", keyCode: 13 }
      : { key: "Enter", keyCode: 13, ctrlKey: true };

    it("leaves an Enter marked isComposing to the editor (negative)", async () => {
      const { user, composer } = await openFlyout(enterToSubmit);
      await user.type(composer, "にほんご");
      const composing = { ...send, isComposing: true };

      // fireEvent answers false when a handler prevented the key's default.
      expect(fireEvent.keyDown(composer, composing)).toBe(true);
      expect(askAssistant).not.toHaveBeenCalled();
      expect(composer).toHaveValue("にほんご");
    });

    it("leaves an Enter with keyCode 229 to the editor (negative)", async () => {
      const { user, composer } = await openFlyout(enterToSubmit);
      await user.type(composer, "中文");
      const committing = { ...send, keyCode: 229 };

      expect(fireEvent.keyDown(composer, committing)).toBe(true);
      expect(askAssistant).not.toHaveBeenCalled();
      expect(composer).toHaveValue("中文");
    });

    it("sends on the send key once the composition has ended", async () => {
      const { user, composer } = await openFlyout(enterToSubmit);
      await user.type(composer, "中文");
      fireEvent.keyDown(composer, { ...send, keyCode: 229 });

      expect(fireEvent.keyDown(composer, send)).toBe(false);
      expectAsked("中文");
    });
  },
);
