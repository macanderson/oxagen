// @vitest-environment jsdom
/**
 * sandbox-files-drawer.test.tsx
 *
 * Covers the drawer's data path: opening it calls the injected `listFiles`
 * loader (bound to `list_sandbox_files` in the app) and renders the tree;
 * selecting a file calls `readFile` and shows its contents; the disabled state
 * (no manage rights) shows a message and never loads. The injected loaders
 * stand in for the real server actions, so asserting on their calls proves the
 * wiring — and that the old cross-service fetch is gone.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import {
  SandboxFilesDrawer,
  type ListSandboxFilesFn,
  type ReadSandboxFileFn,
} from "./sandbox-files-drawer";

afterEach(cleanup);

function renderDrawer(
  over: {
    listFiles?: ListSandboxFilesFn;
    readFile?: ReadSandboxFileFn;
    disabled?: boolean;
  } = {},
) {
  const listFiles =
    over.listFiles ??
    vi.fn(async () => [
      { path: "README.md", kind: "file" as const, sizeBytes: 12 },
    ]);
  const readFile =
    over.readFile ??
    vi.fn(async () => ({
      path: "README.md",
      content: "# hello",
      encoding: "utf8" as const,
      sizeBytes: 7,
      truncated: false,
    }));
  render(
    <SandboxFilesDrawer
      sessionId="sbx_abc123def456"
      status="running"
      listFiles={listFiles}
      readFile={readFile}
      disabled={over.disabled}
    />,
  );
  return { listFiles, readFile };
}

describe("SandboxFilesDrawer", () => {
  it("loads the file tree via the injected loader when opened", async () => {
    const { listFiles } = renderDrawer();
    // Closed → nothing loaded yet.
    expect(listFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sandbox-files-open"));

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    // Root fetch uses the lazy depth, no path.
    expect(listFiles).toHaveBeenCalledWith({ depth: 2 });
    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("reads a file via the injected loader when a file is selected", async () => {
    const { readFile } = renderDrawer();
    fireEvent.click(screen.getByTestId("sandbox-files-open"));

    const fileButton = await screen.findByLabelText("View README.md");
    fireEvent.click(fileButton);

    await waitFor(() => expect(readFile).toHaveBeenCalledWith("README.md"));
    expect(await screen.findByText("# hello")).toBeTruthy();
  });

  it("shows a manage-rights message and never loads when disabled", async () => {
    const { listFiles } = renderDrawer({ disabled: true });
    fireEvent.click(screen.getByTestId("sandbox-files-open"));

    expect(await screen.findByText(/lack manage rights/)).toBeTruthy();
    expect(listFiles).not.toHaveBeenCalled();
  });
});
