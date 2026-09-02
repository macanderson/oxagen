// @vitest-environment jsdom
/**
 * workspace-context-panel.test.tsx
 *
 * Covers:
 *   - Missing org/workspace slug or sessionId => "missing workspace context"
 *     message, and fetch is NOT called
 *   - Loading skeleton while the fetch is pending
 *   - Success => renders file names from entries via FileTreeCard, and fetch
 *     was called once with the correct scoped URL, POST method, and a JSON
 *     body containing sessionId
 *   - Error (non-ok response or thrown error) => visible error card
 *   - Sandbox status strip: running chip, shortened copyable session id,
 *     refresh button refetches the root listing
 *   - Lazy directory expansion: opening a dir beyond the fetched depth
 *     triggers a scoped list fetch for that path and merges the entries
 *   - File viewer: tapping a file fetches /agent/sandbox/file and shows the
 *     content in a mono <pre> (with a binary notice for base64 payloads)
 *   - computeLoadedDirs / mergeEntries / shortSessionId helpers
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkspaceContextPanel, {
  computeLoadedDirs,
  mergeEntries,
  shortSessionId,
} from "./workspace-context-panel";
import type { FileTreeEntry } from "./file-tree-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** fetch stub that answers /files and /file with the given payloads. */
function stubSandboxFetch({
  filesResponses,
  fileResponse,
}: {
  filesResponses: Array<{ entries: FileTreeEntry[] }>;
  fileResponse?: Record<string, unknown>;
}) {
  let filesCall = 0;
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    if (url.endsWith("/agent/sandbox/files")) {
      const body =
        filesResponses[Math.min(filesCall, filesResponses.length - 1)];
      filesCall += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(fileResponse ?? {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WorkspaceContextPanel", () => {
  it("shows missing-context message and does not fetch when org/workspace slugs are absent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceContextPanel sessionId="sbx_123" />);
    expect(screen.getByText(/missing workspace context/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows missing-context message and does not fetch when sessionId is absent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceContextPanel
        sessionId=""
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByText(/missing workspace context/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders a loading skeleton while the fetch is pending", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders file names from entries on success and calls fetch once with the scoped URL, POST, and a JSON body containing sessionId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          entries: [
            { path: "README.md", kind: "file", sizeBytes: 100 },
            { path: "src/index.ts", kind: "file", sizeBytes: 200 },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });
    expect(screen.getByText("index.ts")).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/acme/main/agent/sandbox/files",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { sessionId: string };
    expect(body.sessionId).toBe("sbx_123");

    vi.unstubAllGlobals();
  });

  it("renders the given title on top of the file tree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            entries: [{ path: "a.ts", kind: "file", sizeBytes: 10 }],
          }),
      }),
    );
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
        title="Sandbox files"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Sandbox files")).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("shows a visible error card when the response is non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Failed to load workspace files/),
      ).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("shows a visible error card when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Failed to load workspace files: Network error/),
      ).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("renders the sandbox status strip: running chip, shortened session id, refresh button", async () => {
    stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "a.ts", kind: "file", sizeBytes: 10 }] },
      ],
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_0123456789abcdef"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("a.ts");
    expect(screen.getByText("Sandbox running")).toBeInTheDocument();
    // Shortened (14 chars + ellipsis), full id on the copy control's title.
    expect(
      screen.getByText(shortSessionId("sbx_0123456789abcdef")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy session id" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh files" }),
    ).toBeInTheDocument();
  });

  it("copies the full session id to the clipboard", async () => {
    stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "a.ts", kind: "file", sizeBytes: 10 }] },
      ],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_0123456789abcdef"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("a.ts");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy session id" }),
    );
    expect(writeText).toHaveBeenCalledWith("sbx_0123456789abcdef");
  });

  it("refetches the root listing when the refresh button is pressed", async () => {
    const fetchMock = stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "a.ts", kind: "file", sizeBytes: 10 }] },
      ],
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("a.ts");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Refresh files" }),
    );
    await screen.findByText("a.ts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "/api/v1/acme/main/agent/sandbox/files",
    );
  });

  it("lazily fetches a deeper listing when expanding a dir beyond the fetched depth", async () => {
    const fetchMock = stubSandboxFetch({
      filesResponses: [
        {
          entries: [
            { path: "src", kind: "dir", sizeBytes: 0 },
            { path: "src/deep", kind: "dir", sizeBytes: 0 },
          ],
        },
        {
          entries: [{ path: "src/deep/inner.ts", kind: "file", sizeBytes: 5 }],
        },
      ],
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    // Root listing (depth 2): "src" is open by default and already loaded —
    // no extra fetch for it. "deep" sits AT the depth boundary → unloaded.
    await screen.findByText("deep");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByText("deep"));
    await screen.findByText("inner.ts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1]!;
    expect(secondCall[0]).toBe("/api/v1/acme/main/agent/sandbox/files");
    const body = JSON.parse((secondCall[1] as RequestInit).body as string) as {
      path: string;
      depth: number;
    };
    expect(body.path).toBe("src/deep");
    expect(body.depth).toBe(2);

    // Re-collapsing and re-opening the now-loaded dir must not refetch.
    await userEvent.click(screen.getByText("deep"));
    await userEvent.click(screen.getByText("deep"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens the file viewer on tap: fetches /agent/sandbox/file and shows the content", async () => {
    const fetchMock = stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "README.md", kind: "file", sizeBytes: 11 }] },
      ],
      fileResponse: {
        path: "README.md",
        content: "hello sandbox",
        encoding: "utf8",
        sizeBytes: 13,
        truncated: false,
      },
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("README.md");

    await userEvent.click(
      screen.getByRole("button", { name: "View README.md" }),
    );
    await screen.findByText("hello sandbox");

    const fileCall = fetchMock.mock.calls.find(([u]) =>
      u.endsWith("/agent/sandbox/file"),
    )!;
    expect(fileCall[0]).toBe("/api/v1/acme/main/agent/sandbox/file");
    const body = JSON.parse((fileCall[1] as RequestInit).body as string) as {
      sessionId: string;
      path: string;
    };
    expect(body).toMatchObject({ sessionId: "sbx_123", path: "README.md" });
  });

  it("shows a binary notice for base64 file payloads", async () => {
    stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "logo.png", kind: "file", sizeBytes: 2048 }] },
      ],
      fileResponse: {
        path: "logo.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        sizeBytes: 2048,
        truncated: false,
      },
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("logo.png");

    await userEvent.click(
      screen.getByRole("button", { name: "View logo.png" }),
    );
    await screen.findByText(/Binary file/);
    expect(screen.getByText("iVBORw0KGgo=")).toBeInTheDocument();
  });

  it("shows a truncation notice when the file was larger than maxBytes", async () => {
    stubSandboxFetch({
      filesResponses: [
        { entries: [{ path: "big.log", kind: "file", sizeBytes: 999999 }] },
      ],
      fileResponse: {
        path: "big.log",
        content: "first part",
        encoding: "utf8",
        sizeBytes: 999_999,
        truncated: true,
      },
    });
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("big.log");

    await userEvent.click(screen.getByRole("button", { name: "View big.log" }));
    await screen.findByText(/File truncated/);
  });

  it("shows a visible viewer error when the file read fails", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/agent/sandbox/files")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              entries: [{ path: "a.ts", kind: "file", sizeBytes: 5 }],
            }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceContextPanel
        sessionId="sbx_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await screen.findByText("a.ts");

    await userEvent.click(screen.getByRole("button", { name: "View a.ts" }));
    await screen.findByText(/Failed to read file: HTTP 500/);
  });
});

describe("computeLoadedDirs", () => {
  const entries: FileTreeEntry[] = [
    { path: "src", kind: "dir", sizeBytes: 0 },
    { path: "src/deep", kind: "dir", sizeBytes: 0 },
    { path: "src/index.ts", kind: "file", sizeBytes: 10 },
  ];

  it("marks the base and depth-1 dirs loaded after a depth-2 fetch from root", () => {
    const loaded = computeLoadedDirs("", entries, 2);
    expect(loaded.has("")).toBe(true);
    expect(loaded.has("src")).toBe(true);
    // "src/deep" sits AT the boundary — its children are unknown.
    expect(loaded.has("src/deep")).toBe(false);
  });

  it("marks implied ancestor dirs loaded even without their own dir entry", () => {
    const loaded = computeLoadedDirs(
      "",
      [{ path: "src/components/button.tsx", kind: "file", sizeBytes: 1 }],
      3,
    );
    expect(loaded.has("src")).toBe(true);
    expect(loaded.has("src/components")).toBe(true);
  });

  it("computes relative depth against a non-root base", () => {
    const loaded = computeLoadedDirs(
      "src/deep",
      [{ path: "src/deep/sub", kind: "dir", sizeBytes: 0 }],
      2,
    );
    expect(loaded.has("src/deep")).toBe(true);
    expect(loaded.has("src/deep/sub")).toBe(true);
  });
});

describe("mergeEntries", () => {
  it("dedupes by path, letting incoming entries win", () => {
    const merged = mergeEntries(
      [{ path: "a.ts", kind: "file", sizeBytes: 1 }],
      [
        { path: "a.ts", kind: "file", sizeBytes: 2 },
        { path: "b.ts", kind: "file", sizeBytes: 3 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.path === "a.ts")?.sizeBytes).toBe(2);
  });
});

describe("shortSessionId", () => {
  it("returns short ids unchanged", () => {
    expect(shortSessionId("sbx_123")).toBe("sbx_123");
  });

  it("truncates long ids with an ellipsis", () => {
    expect(shortSessionId("sbx_0123456789abcdef")).toBe("sbx_0123456789…");
  });
});
