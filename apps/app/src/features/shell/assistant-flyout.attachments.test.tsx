// @vitest-environment jsdom
// Files attached to a question in the assistant flyout (#4690, ADR-222),
// over a fake stream client and a stubbed upload route: a picked file uploads
// at once, the question carries its stored id, and the file shows under the
// question once it is sent. A file whose upload was refused holds Send until
// it is removed, and a file of a type stella cannot read never uploads.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type {
  AssistantQuestion,
  AssistantStreamHandlers,
  AssistantStreamResult,
} from "./assistant-stream-client";
import { ShellStateProvider, useShellState } from "./shell-state";

const questions: AssistantQuestion[] = [];
const askAssistantStream = vi.fn(
  (
    _org: string,
    _ws: string,
    question: AssistantQuestion,
    _on: AssistantStreamHandlers = {},
  ) => {
    questions.push(question);
    return new Promise<AssistantStreamResult>(() => undefined);
  },
);
vi.mock("./assistant-stream-client", () => ({ askAssistantStream }));
vi.mock("./assistant-actions", () => ({ readAssistantReply: vi.fn() }));
// The engine read never answers, so nothing but a turn in flight or a file
// holds Send.
vi.mock("./engine-actions", () => ({
  readAssistantEngine: () => new Promise(() => undefined),
}));
vi.mock("./assistant-thread-actions", () => ({
  loadAssistantThread: (_org: string, ws: string) =>
    Promise.resolve({
      ok: true,
      value: { workspaceKey: `id-${ws}`, thread: null },
    }),
  listAssistantSessions: vi.fn(),
  openAssistantSession: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { AssistantFlyout } = await import("./assistant-flyout");

const upload = vi.fn();

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

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

/** Open the flyout, type a question, and attach one file through the paperclip's input. */
async function attachInOpenFlyout(text: string, file: File) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <OpenIt />
        <AssistantFlyout />
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open assistant" }));
  await user.type(screen.getByTestId("assistant-composer"), text);
  fireEvent.change(screen.getByTestId("assistant-attach-input"), {
    target: { files: [file] },
  });
  return { user, flyout: screen.getByTestId("assistant-flyout") };
}

beforeEach(() => {
  questions.length = 0;
  askAssistantStream.mockClear();
  upload.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal("fetch", upload);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assistant flyout attachments", () => {
  it("uploads a picked file, sends its id with the question, and shows it under the question", async () => {
    upload.mockResolvedValue(
      answer(200, {
        publicId: "gen_abc",
        name: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 5,
        sha256: "x",
      }),
    );
    const { user, flyout } = await attachInOpenFlyout(
      "Summarise these notes",
      new File(["hello"], "notes.md", { type: "text/markdown" }),
    );
    const chips = await screen.findByTestId("assistant-attachments");
    expect(within(chips).getByText("notes.md")).toBeTruthy();
    expect(within(chips).getByText("Markdown")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("assistant-send")).not.toHaveAttribute("aria-disabled");
    });
    expect(upload).toHaveBeenCalledWith(
      "/api/v1/acme/core-platform/assistant/attachments/upload",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "notes.md",
          mediaType: "text/markdown",
          data: "aGVsbG8=",
        }),
      }),
    );
    await expectNoAxe(flyout);

    await user.click(screen.getByTestId("assistant-send"));
    await waitFor(() => {
      expect(questions).toHaveLength(1);
    });
    expect(questions[0]?.attachments).toEqual(["gen_abc"]);
    const sent = await screen.findByTestId("assistant-sent-attachments");
    expect(within(sent).getByText("notes.md")).toBeTruthy();
    expect(within(sent).queryByRole("button")).toBeNull();
    // The sent chip opens the stored file through the workspace's read route.
    const link = within(sent).getByRole("link", { name: "Open notes.md in a new tab" });
    expect(link).toHaveAttribute(
      "href",
      "/api/v1/acme/core-platform/assistant/attachments/gen_abc",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByTestId("assistant-attachments")).toBeNull();
    await expectNoAxe(flyout);
  });

  it("sends no attachments field with a question that carries no files", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <ShellStateProvider>
          <OpenIt />
          <AssistantFlyout />
        </ShellStateProvider>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    await user.type(screen.getByTestId("assistant-composer"), "Hello");
    await user.click(screen.getByTestId("assistant-send"));
    await waitFor(() => {
      expect(questions).toHaveLength(1);
    });
    expect(questions[0]).not.toHaveProperty("attachments");
    expect(upload).not.toHaveBeenCalled();
  });

  it("holds Send while a refused file is on the composer, until it is removed (negative)", async () => {
    upload.mockResolvedValue(
      answer(400, {
        error: {
          code: "attachment_refused",
          reason: "bytes_do_not_match_type",
          message: "The file's contents do not match its type.",
        },
      }),
    );
    const { user } = await attachInOpenFlyout(
      "What is in this picture?",
      new File(["not a png"], "shot.png", { type: "image/png" }),
    );
    expect(await screen.findByText("Contents unreadable")).toBeTruthy();
    expect(screen.getByTestId("assistant-attachments-blocked")).toBeTruthy();
    expect(screen.getByTestId("assistant-send")).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByTestId("assistant-send"));
    expect(askAssistantStream).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByTestId("assistant-attachments-blocked")).toBeNull();
    expect(screen.getByTestId("assistant-send")).not.toHaveAttribute("aria-disabled");
  });

  it("attaches a pasted screenshot and a dropped file", async () => {
    upload.mockResolvedValue(
      answer(200, { publicId: "gen_img", mediaType: "image/png", sizeBytes: 4, sha256: "x" }),
    );
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <ShellStateProvider>
          <OpenIt />
          <AssistantFlyout />
        </ShellStateProvider>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    const composer = screen.getByTestId("assistant-composer");
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File(["\u0089PNG"], "image.png", { type: "image/png" })],
        types: ["Files"],
      },
    });
    fireEvent.drop(composer, {
      dataTransfer: {
        files: [new File(["# notes"], "notes.md", { type: "" })],
        types: ["Files"],
      },
    });
    const chips = await screen.findByTestId("assistant-attachments");
    expect(within(chips).getByText("image.png")).toBeTruthy();
    expect(within(chips).getByText("notes.md")).toBeTruthy();
    await waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps a spreadsheet paste as text, not as the picture it carries beside it (negative)", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <ShellStateProvider>
          <OpenIt />
          <AssistantFlyout />
        </ShellStateProvider>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "open assistant" }));
    fireEvent.paste(screen.getByTestId("assistant-composer"), {
      clipboardData: {
        files: [new File(["\u0089PNG"], "image.png", { type: "image/png" })],
        types: ["text/plain", "text/html", "Files"],
      },
    });
    expect(screen.queryByTestId("assistant-attachments")).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("never uploads a file of a type stella cannot read (negative)", async () => {
    await attachInOpenFlyout(
      "Run this",
      new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }),
    );
    expect(await screen.findByText("Unsupported type")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByTestId("assistant-send")).toHaveAttribute("aria-disabled", "true");
  });
});
