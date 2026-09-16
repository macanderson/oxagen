// @vitest-environment jsdom
// /{org}/{ws}/register/{step} names itself pages.register in the tab and the
// one h1 (ARCHITECTURE.md §1.2), resolves the workspace viewer, and hands the
// step and the identity the URL names to the register flow. A segment that
// names no step is a 404, so the flow has three addresses and no catch-all.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { expectPageTitle, routeProps } from "@/test/render-page";

const { requireViewer, RegisterAgent, notFound, source } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  RegisterAgent: vi.fn((_props: Record<string, unknown>) => (
    <p data-testid="register-body" />
  )),
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
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const SEGMENTS = { org: "acme", ws: "core-platform", step: "wrap" };

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({ orgSlug: "acme", wsSlug: "core-platform" });
  RegisterAgent.mockClear();
});

describe("/[org]/[ws]/register/[step]", () => {
  it("names the page once and hands the viewer, the source, the step and the identity to the flow", async () => {
    await expectPageTitle(
      await import("./page"),
      routeProps(SEGMENTS, { agent: "agt_releasebot" }),
      translator("pages")("register"),
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(RegisterAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        step: "wrap",
        agent: "agt_releasebot",
      }),
      undefined,
    );
    expect(screen.getByTestId("register-body")).toBeInTheDocument();
  });

  it("passes no identity when the URL names none", async () => {
    const page = await import("./page");
    await page.default(routeProps({ ...SEGMENTS, step: "name" }));
    expect(RegisterAgent).toHaveBeenCalledWith(
      expect.objectContaining({ step: "name", agent: null }),
      undefined,
    );
  });

  it("answers a segment that names no step with a 404 (negative)", async () => {
    const page = await import("./page");
    await expect(
      page.default(routeProps({ ...SEGMENTS, step: "organization" })),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(RegisterAgent).not.toHaveBeenCalled();
  });
});
