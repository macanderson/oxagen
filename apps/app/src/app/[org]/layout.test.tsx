// The organization layout resolves the viewer for the organization slug and
// hands the context to the shell chrome and to the clock around its pages; a
// stranger is a 404 and neither renders. While the viewer resolves, the page
// body is the shared skeleton rather than nothing. The real shell frame renders
// here, because its one <main id="main"> sits above the layout's <Suspense>,
// and the skip link needs that target while the page streams in (ADR-227).
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { NotFound, requireViewer } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
  requireViewer: vi.fn((org: string) =>
    org === "acme"
      ? Promise.resolve({ orgSlug: "acme" })
      : org === "slow"
        ? new Promise<never>(() => undefined)
        : Promise.reject(new NotFound("NEXT_NOT_FOUND")),
  ),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/data/source", () => ({ dataSource: () => ({}) }));
// The sign-in toast reads the session; here it only has to sit inside the clock.
vi.mock("@/features/auth", () => ({
  SignedInNotice: () => <div data-testid="signed-in-notice" />,
}));
// The frame's copy is its loading line; the page-name provider reads the
// client router, which a server render does not mount.
vi.mock("next-intl/server", () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock("@/features/shell/route-page-name", () => ({
  ShellRoutePageName: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/features/shell", async () => ({
  ShellFrame: (
    await vi.importActual<typeof import("@/features/shell/shell-frame")>(
      "@/features/shell/shell-frame",
    )
  ).ShellFrame,
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

vi.mock("@/ui/page-states", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

import OrganizationLayout from "./layout";

async function render(org: string) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(
    <OrganizationLayout params={Promise.resolve({ org })}>
      <div data-testid="page">page</div>
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

  it("draws the shared skeleton in the page's place while the viewer resolves", async () => {
    const reading = new AbortController();
    const stream = await renderToReadableStream(
      <OrganizationLayout params={Promise.resolve({ org: "slow" })}>
        <div data-testid="page">page</div>
      </OrganizationLayout>,
      { signal: reading.signal, onError: () => undefined },
    );
    // The shell has streamed and the viewer has not answered: stop there.
    reading.abort();
    const html = await new Response(stream).text();
    expect(html).toContain('data-testid="page-skeleton"');
    expect(html).not.toContain('data-testid="page"');
  });

  it("keeps one main landmark, around the skeleton, while the page streams in beside it", async () => {
    // Next streams a page that is still reading into a hidden segment after
    // the shell, then swaps it into the fallback's place, so for a moment
    // both are in the document. The page must not bring a second main#main
    // (#4053): the frame's one landmark holds the fallback, then the page.
    const reading = Promise.withResolvers<"ready">();
    async function StreamedPage() {
      await reading.promise;
      return <div data-testid="page">page</div>;
    }
    const stream = await renderToReadableStream(
      <OrganizationLayout params={Promise.resolve({ org: "acme" })}>
        <StreamedPage />
      </OrganizationLayout>,
      { onError: () => undefined },
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // React types the stream's chunks as any. They are bytes: check, then
    // decode, or answer null once the stream ends.
    async function nextChunk(): Promise<string | null> {
      const chunk = await reader.read();
      if (chunk.done) return null;
      const bytes: unknown = chunk.value;
      if (!ArrayBuffer.isView(bytes)) throw new TypeError("React streamed a chunk that is not bytes");
      return decoder.decode(bytes, { stream: true });
    }
    // The shell flushes in one go, with the fallback in the page's place; read
    // its chunks up to the frame's closing tag.
    let html = "";
    while (!html.includes("</main>")) {
      const chunk = await nextChunk();
      if (chunk === null) break;
      html += chunk;
    }
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(
      /<main id="main"[^>]*>.*data-testid="page-skeleton".*<\/main>/s,
    );
    expect(html).not.toContain('data-testid="page"');
    reading.resolve("ready");
    for (;;) {
      const chunk = await nextChunk();
      if (chunk === null) break;
      html += chunk;
    }
    // The page arrived in its hidden segment after the frame's landmark, and
    // the document still holds one main.
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="page"')).toBeGreaterThan(
      html.indexOf("</main>"),
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
