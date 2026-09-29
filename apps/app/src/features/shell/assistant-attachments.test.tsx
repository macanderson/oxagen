// @vitest-environment jsdom
// The files on the assistant's composer (#4690, ADR-222): the chips show each
// file's kind and size as two separate elements, the paperclip hands picked
// files over, and the state uploads each file as it is attached, settles its
// chip, and hands the stored ids to the message.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  AssistantAttachmentChips,
  AssistantAttachmentPicker,
  useAssistantAttachments,
} from "./assistant-attachments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withIntl(children: ReactNode) {
  return render(<IntlProvider>{children}</IntlProvider>);
}

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function stored(publicId: string, mediaType = "text/plain") {
  return answer(200, { publicId, name: "a", mediaType, sizeBytes: 5, sha256: "x" });
}

describe("AssistantAttachmentChips", () => {
  const files = [
    {
      key: "file-1",
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 2_500_000,
      state: "done" as const,
      problem: null,
    },
    {
      key: "file-2",
      name: "shot.png",
      mediaType: "image/png",
      size: 1024,
      state: "uploading" as const,
      problem: null,
    },
    {
      key: "file-3",
      name: "huge.txt",
      mediaType: "text/plain",
      size: 1_000_000,
      state: "error" as const,
      problem: "size" as const,
    },
  ];

  it("shows the kind and the size as two separate elements, never joined by punctuation", () => {
    withIntl(<AssistantAttachmentChips files={files} onRemove={() => undefined} />);
    const [pdf] = screen.getAllByTestId("assistant-attachment");
    const description = pdf?.querySelector('[data-slot="attachment-description"]');
    expect(Array.from(description?.children ?? [], (c) => c.textContent)).toEqual([
      "PDF",
      "2.5 MB",
    ]);
    expect(description?.textContent).not.toMatch(/[·,]/);
  });

  it("says a file is uploading, and names the problem on a refused one", () => {
    withIntl(<AssistantAttachmentChips files={files} onRemove={() => undefined} />);
    const [, uploading, refused] = screen.getAllByTestId("assistant-attachment");
    if (uploading === undefined || refused === undefined) {
      throw new Error("expected three chips");
    }
    expect(uploading).toHaveAttribute("aria-busy", "true");
    expect(within(uploading).getByText("Uploading…")).toBeTruthy();
    expect(refused).toHaveAttribute("data-state", "error");
    expect(within(refused).getByText("Too large")).toBeTruthy();
    expect(within(refused).getByText("Text")).toBeTruthy();
  });

  it("removes the file whose Remove button is pressed", async () => {
    const onRemove = vi.fn();
    const { container } = withIntl(
      <AssistantAttachmentChips files={files} onRemove={onRemove} testId="chips" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(onRemove).toHaveBeenCalledWith("file-2");
    expect(screen.getByRole("list", { name: "Attached files" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
    await expectNoAxe(container);
  });

  it("draws no Remove button and announces nothing under a sent question (negative)", () => {
    withIntl(<AssistantAttachmentChips files={files.slice(0, 1)} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("list", { name: "Attached files" })).not.toHaveAttribute(
      "aria-live",
    );
  });

  it("links a sent file's name to where it is stored, in a new tab", async () => {
    const [pdf] = files;
    if (pdf === undefined) throw new Error("expected a file");
    const { container } = withIntl(
      <AssistantAttachmentChips
        files={[{ ...pdf, href: "/api/v1/acme/core/assistant/attachments/gen_abc" }]}
      />,
    );
    const link = screen.getByRole("link", { name: "Open report.pdf in a new tab" });
    expect(link).toHaveAttribute("href", "/api/v1/acme/core/assistant/attachments/gen_abc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("report.pdf");
    await expectNoAxe(container);
  });

  it("links nothing for a file without a stored place, as on the composer (negative)", () => {
    withIntl(<AssistantAttachmentChips files={files} onRemove={() => undefined} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws nothing when there are no files", () => {
    const { container } = withIntl(<AssistantAttachmentChips files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AssistantAttachmentPicker", () => {
  it("hands the picked files over", () => {
    const onFiles = vi.fn();
    withIntl(<AssistantAttachmentPicker onFiles={onFiles} />);
    const input = screen.getByTestId("assistant-attach-input");
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
  });

  it("is disabled while a turn is in flight (negative)", () => {
    withIntl(<AssistantAttachmentPicker onFiles={() => undefined} disabled />);
    expect(screen.getByTestId("assistant-attach")).toBeDisabled();
  });
});

describe("useAssistantAttachments", () => {
  it("uploads a file as it is attached and hands its id to the message", async () => {
    const fetch = vi.fn(() => Promise.resolve(stored("gen_abc")));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useAssistantAttachments("acme", "core"));
    act(() => {
      result.current.add([new File(["hello"], "a.txt", { type: "text/plain" })]);
    });
    expect(result.current.files[0]?.state).toBe("uploading");
    expect(result.current.uploading).toBe(true);
    await waitFor(() => {
      expect(result.current.files[0]?.state).toBe("done");
    });
    expect(result.current.uploading).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    let sent: ReturnType<typeof result.current.take> = [];
    act(() => {
      sent = result.current.take();
    });
    expect(sent).toEqual([
      {
        key: "file-1",
        name: "a.txt",
        mediaType: "text/plain",
        size: 5,
        publicId: "gen_abc",
        href: "/api/v1/acme/core/assistant/attachments/gen_abc",
      },
    ]);
    expect(result.current.files).toEqual([]);
  });

  it("marks a file whose upload failed, and holds Send until it is removed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    const { result } = renderHook(() => useAssistantAttachments("acme", "core"));
    act(() => {
      result.current.add([new File(["x"], "a.txt", { type: "text/plain" })]);
    });
    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    expect(result.current.files[0]?.problem).toBe("upload");
    act(() => {
      result.current.remove("file-1");
    });
    expect(result.current.failed).toBe(false);
  });

  it("uploads nothing for a file that breaks a rule (negative)", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useAssistantAttachments("acme", "core"));
    act(() => {
      result.current.add([new File(["MZ"], "app.exe", { type: "application/x-msdownload" })]);
    });
    expect(result.current.files[0]?.problem).toBe("type");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a late answer for a file removed while it uploaded", async () => {
    let settle: (value: unknown) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useAssistantAttachments("acme", "core"));
    act(() => {
      result.current.add([new File(["hello"], "a.txt", { type: "text/plain" })]);
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    act(() => {
      result.current.remove("file-1");
    });
    await act(async () => {
      settle(stored("gen_late"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.files).toEqual([]);
  });

  it("clears the files when the person moves to another workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(stored("gen_abc"))));
    const { result, rerender } = renderHook(
      ({ ws }: { ws: string }) => useAssistantAttachments("acme", ws),
      { initialProps: { ws: "core" } },
    );
    act(() => {
      result.current.add([new File(["hello"], "a.txt", { type: "text/plain" })]);
    });
    await waitFor(() => {
      expect(result.current.files[0]?.state).toBe("done");
    });
    rerender({ ws: "other" });
    expect(result.current.files).toEqual([]);
  });
});
