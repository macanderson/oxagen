// @vitest-environment jsdom
/**
 * child-drawer.test.tsx — render tests for ChildDrawer.
 *
 * Mocks global fetch for the three same-origin routes it calls
 * (result GET on open, siblings GET on demand, logs POST on download) and
 * @/components/ui/toast. Renders the real Drawer/Sheet, Badge, Button.
 *
 * Covers:
 *   - fetches the result payload on open and renders input/output JSON
 *   - a result fetch failure renders the inline error, not a stuck skeleton
 *   - siblings section only appears for a running child; "Load siblings"
 *     fetches and renders sibling rows
 *   - a non-running child never shows the siblings section
 *   - download logfile POSTs {workspaceId, fanoutId} and opens the returned URL
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChildDrawer, type ChildDrawerRun } from "./child-drawer";

afterEach(cleanup);

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

function makeRun(overrides: Partial<ChildDrawerRun> = {}): ChildDrawerRun {
  return {
    runId: "sar_1",
    capabilityName: "search_web",
    status: "completed",
    errorReason: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:01:00.000Z",
    durationMs: 60_000,
    inputBytes: 128,
    outputBytes: 512,
    outputPreview: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("open", vi.fn());
});

describe("ChildDrawer — payload viewer", () => {
  it("fetches the result on open and renders input/output JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runId: "sar_1",
        fanoutId: "fo_1",
        capabilityName: "search_web",
        status: "completed",
        summary: null,
        input: { query: "oxagen" },
        output: { results: ["a", "b"] },
        errorReason: null,
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:01:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChildDrawer
        open
        onOpenChange={vi.fn()}
        run={makeRun()}
        fanoutId="fo_1"
        workspaceId="w1"
      />,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/agent/subagent/result?workspaceId=w1&runId=sar_1"),
    );

    await waitFor(() =>
      expect(screen.getByTestId("child-drawer-input")).toHaveTextContent('"query": "oxagen"'),
    );
    expect(screen.getByTestId("child-drawer-output")).toHaveTextContent('"results"');
  });

  it("renders an inline error when the result fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(
      <ChildDrawer open onOpenChange={vi.fn()} run={makeRun()} fanoutId="fo_1" workspaceId="w1" />,
    );

    await waitFor(() => expect(screen.getByTestId("child-drawer-result-error")).toBeInTheDocument());
    expect(screen.queryByTestId("child-drawer-input")).not.toBeInTheDocument();
  });
});

describe("ChildDrawer — siblings", () => {
  it("shows the siblings section only for a running child, and loads on click", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/result")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            runId: "sar_1",
            fanoutId: "fo_1",
            capabilityName: "search_web",
            status: "running",
            summary: null,
            input: {},
            output: null,
            errorReason: null,
            startedAt: "2026-07-12T00:00:00.000Z",
            completedAt: null,
          }),
        });
      }
      if (url.includes("/siblings")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            runId: "sar_1",
            fanoutId: "fo_1",
            siblings: [
              { runId: "sar_2", capabilityName: "summarize_text", status: "running", summary: "in progress", attempts: 1, errorReason: null },
            ],
          }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChildDrawer
        open
        onOpenChange={vi.fn()}
        run={makeRun({ status: "running", completedAt: null })}
        fanoutId="fo_1"
        workspaceId="w1"
      />,
    );

    const loadBtn = await screen.findByTestId("child-drawer-load-siblings-btn");
    await user.click(loadBtn);

    await waitFor(() => expect(screen.getByTestId("child-drawer-siblings-list")).toBeInTheDocument());
    expect(screen.getByText("summarize_text")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/agent/subagent/siblings?workspaceId=w1&runId=sar_1"),
    );
  });

  it("never shows the siblings section for a completed child", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          runId: "sar_1",
          fanoutId: "fo_1",
          capabilityName: "search_web",
          status: "completed",
          summary: null,
          input: {},
          output: {},
          errorReason: null,
          startedAt: "2026-07-12T00:00:00.000Z",
          completedAt: "2026-07-12T00:01:00.000Z",
        }),
      }),
    );

    render(
      <ChildDrawer open onOpenChange={vi.fn()} run={makeRun({ status: "completed" })} fanoutId="fo_1" workspaceId="w1" />,
    );

    await waitFor(() => expect(screen.getByTestId("child-drawer-input")).toBeInTheDocument());
    expect(screen.queryByTestId("child-drawer-load-siblings-btn")).not.toBeInTheDocument();
  });
});

describe("ChildDrawer — download logfile", () => {
  it("POSTs {workspaceId, fanoutId} and opens the returned URL", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ serveUrl: "/api/v1/assets/ast_1" }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          runId: "sar_1",
          fanoutId: "fo_1",
          capabilityName: "search_web",
          status: "completed",
          summary: null,
          input: {},
          output: {},
          errorReason: null,
          startedAt: null,
          completedAt: null,
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChildDrawer open onOpenChange={vi.fn()} run={makeRun()} fanoutId="fo_1" workspaceId="w1" />,
    );

    await user.click(screen.getByTestId("child-drawer-download-logs-btn"));

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith("/api/v1/assets/ast_1", "_blank", "noopener,noreferrer"),
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    const body = JSON.parse((postCall[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ workspaceId: "w1", fanoutId: "fo_1" });
  });

  it("shows an error toast when logfile generation fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          runId: "sar_1",
          fanoutId: "fo_1",
          capabilityName: "search_web",
          status: "completed",
          summary: null,
          input: {},
          output: {},
          errorReason: null,
          startedAt: null,
          completedAt: null,
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChildDrawer open onOpenChange={vi.fn()} run={makeRun()} fanoutId="fo_1" workspaceId="w1" />,
    );

    await user.click(screen.getByTestId("child-drawer-download-logs-btn"));

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't generate logfile" })),
    );
  });
});
