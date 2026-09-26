// @vitest-environment jsdom
// /{org}/{ws}/register/{step} names the step in the tab, resolves the
// workspace viewer, and hands the step and the identity the URL names to the
// gate and, inside its <Suspense>, to the register flow. A segment that names
// no step is a 404, so the flow has three addresses and no catch-all.
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { renderPage, routeProps } from "@/test/render-page";

const { requireViewer, RegisterAgent, RegisterGate, notFound, source } =
  vi.hoisted(() => ({
    requireViewer: vi.fn(),
    RegisterAgent: vi.fn((_props: Record<string, unknown>) => (
      <p data-testid="register-body" />
    )),
    RegisterGate: vi.fn(
      ({ children }: { children: ReactNode } & Record<string, unknown>) => (
        <main data-testid="register-gate">{children}</main>
      ),
    ),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    source: {},
  }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/features/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/onboarding")>()),
  RegisterAgent,
  RegisterGate,
}));
vi.mock("@/features/shell", () => ({ PageRecord: () => null }));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const SEGMENTS = { org: "acme", ws: "core-platform", step: "wrap" };
const VIEWER = { orgSlug: "acme", wsSlug: "core-platform" };

// Imported once, at module scope: the route pulls the whole onboarding barrel
// in behind it, and paying that inside the first test spent its whole budget.
const page = await import("./page");

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(VIEWER);
  RegisterAgent.mockClear();
  RegisterGate.mockClear();
});

describe("/[org]/[ws]/register/[step]", () => {
  it.each([
    ["name", "Define the agent"],
    ["wrap", "Wrap the agent"],
    ["run", "Wait for the first frame"],
  ])("names the %s step in the tab as its h1 does", async (step, title) => {
    const metadata = await page.generateMetadata(
      routeProps({ ...SEGMENTS, step }),
    );
    expect(metadata.title).toBe(title);
  });

  it("keeps the flow's own name for a segment that names no step", async () => {
    const metadata = await page.generateMetadata(
      routeProps({ ...SEGMENTS, step: "organization" }),
    );
    expect(metadata.title).toBe(translator("pages")("register"));
  });

  it("hands the viewer, the step and the identity to the gate and the flow", async () => {
    await renderPage(
      await page.default(routeProps(SEGMENTS, { agent: "agt_releasebot" })),
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(RegisterGate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        ctx: VIEWER,
        step: "wrap",
        agent: "agt_releasebot",
      }),
    );
    expect(RegisterAgent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        ctx: VIEWER,
        source,
        step: "wrap",
        agent: "agt_releasebot",
      }),
    );
    expect(screen.getByTestId("register-body")).toBeInTheDocument();
  });

  it("passes no identity and no runtime when the URL names none", async () => {
    await renderPage(
      await page.default(routeProps({ ...SEGMENTS, step: "name" })),
    );
    expect(RegisterAgent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ step: "name", agent: null, runtime: null }),
    );
  });

  it("hands the runtime Add a runtime chose to the name step (ADR-192)", async () => {
    await renderPage(
      await page.default(
        routeProps(
          { ...SEGMENTS, step: "name" },
          { runtime: "rtm_macslaptop" },
        ),
      ),
    );
    expect(RegisterAgent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ step: "name", runtime: "rtm_macslaptop" }),
    );
  });

  it("answers a segment that names no step with a 404 (negative)", async () => {
    await expect(
      page.default(routeProps({ ...SEGMENTS, step: "organization" })),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(RegisterAgent).not.toHaveBeenCalled();
  });
});
