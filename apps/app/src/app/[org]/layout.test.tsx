// The organization layout resolves the viewer for the organization slug and
// hands the context to the shell chrome and to the clock around its pages; a
// stranger is a 404 and neither renders.
import { type ReactNode, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { NotFound, requireViewer } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
  requireViewer: vi.fn((org: string) =>
    org === "acme"
      ? Promise.resolve({ orgSlug: "acme" })
      : Promise.reject(new NotFound("NEXT_NOT_FOUND")),
  ),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/data/source", () => ({ dataSource: () => ({}) }));
// The sign-in toast reads the session; here it only has to sit inside the clock.
vi.mock("@/features/auth", () => ({
  SignedInNotice: () => <div data-testid="signed-in-notice" />,
}));
// The frame streams the chrome inside its own <Suspense>, as the real one does.
vi.mock("@/features/shell", () => ({
  ShellFrame: ({
    chrome,
    children,
  }: {
    chrome: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <Suspense fallback={null}>{chrome}</Suspense>
      {children}
    </div>
  ),
  ShellChrome: ({ ctx }: { ctx: { orgSlug: string } }) => (
    <nav data-testid="chrome" data-org={ctx.orgSlug} />
  ),
  ViewerClock: ({
    ctx,
    children,
  }: {
    ctx: { orgSlug: string };
    children: ReactNode;
  }) => (
    <div data-testid="clock" data-org={ctx.orgSlug}>
      {children}
    </div>
  ),
}));

import OrganizationLayout from "./layout";

async function render(org: string) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(
    <OrganizationLayout params={Promise.resolve({ org })}>
      <main data-testid="page">page</main>
    </OrganizationLayout>,
    {
      onError(error) {
        errors.push(error);
      },
    },
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  return { html, errors };
}

describe("OrganizationLayout", () => {
  it("hands the chrome the context requireViewer resolved for the organization slug", async () => {
    const { html, errors } = await render("acme");
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(html).toContain('data-testid="chrome" data-org="acme"');
    expect(errors).toEqual([]);
  });

  it("wraps the page in the viewer's clock, resolved for the same slug", async () => {
    const { html } = await render("acme");
    expect(html).toMatch(
      /data-testid="clock" data-org="acme">.*data-testid="page"/s,
    );
  });

  it("mounts the sign-in toast inside the clock, after the page", async () => {
    const { html } = await render("acme");
    expect(html).toMatch(
      /data-testid="clock" data-org="acme">.*data-testid="page".*data-testid="signed-in-notice"/s,
    );
  });

  it("is not found for an organization the viewer does not belong to, and neither the chrome nor the page renders", async () => {
    const { html, errors } = await render("globex");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((e) => e instanceof NotFound)).toBe(true);
    expect(html).not.toContain('data-testid="chrome"');
    expect(html).not.toContain('data-testid="page"');
    expect(html).not.toContain('data-testid="signed-in-notice"');
  });
});
