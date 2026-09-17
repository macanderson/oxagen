// The organization layout resolves the viewer for the organization slug and
// hands the context to the shell chrome; a stranger is a 404 and the chrome
// never renders.
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
    expect(html).toContain('data-org="acme"');
    expect(errors).toEqual([]);
  });

  it("is not found for an organization the viewer does not belong to, and the chrome never renders", async () => {
    const { html, errors } = await render("globex");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFound);
    expect(html).not.toContain('data-testid="chrome"');
  });
});
