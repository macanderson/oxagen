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
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import WorkspaceContextPanel from "./workspace-context-panel";

afterEach(cleanup);

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
    render(<WorkspaceContextPanel sessionId="" orgSlug="acme" workspaceSlug="main" />);
    expect(screen.getByText(/missing workspace context/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders a loading skeleton while the fetch is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => {})),
    );
    render(<WorkspaceContextPanel sessionId="sbx_123" orgSlug="acme" workspaceSlug="main" />);
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

    render(<WorkspaceContextPanel sessionId="sbx_123" orgSlug="acme" workspaceSlug="main" />);

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
        json: () => Promise.resolve({ entries: [{ path: "a.ts", kind: "file", sizeBytes: 10 }] }),
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
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );
    render(<WorkspaceContextPanel sessionId="sbx_123" orgSlug="acme" workspaceSlug="main" />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load workspace files/)).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("shows a visible error card when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    render(<WorkspaceContextPanel sessionId="sbx_123" orgSlug="acme" workspaceSlug="main" />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load workspace files: Network error/)).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });
});
