// The workspace layout is the guard for every page under /[org]/[ws]: it
// resolves the viewer for both slugs through requireViewer and renders the page
// only once that resolves. The shell's reads are not imported here, so a
// failing shell context read cannot let a non-member through (F3).
import { type ReactElement, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { NotFound, requireViewer, CreateHost } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
  requireViewer: vi.fn((org: string, ws?: string) => {
    if (org === "acme" && ws === "core-platform")
      return Promise.resolve({
        userId: "u1",
        orgSlug: "acme",
        wsSlug: "core-platform",
        wsName: "Core platform",
      });
    return Promise.reject(new NotFound("NEXT_NOT_FOUND"));
  }),
  CreateHost: vi.fn((props: { org: string; ws: string; wsName: string }) => (
    <div data-testid="create-host" data-ws={props.ws} />
  )),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/features/create", () => ({ CreateHost }));
// The skeleton reads the catalog; here it only has to be the fallback.
vi.mock("@/ui/page-skeleton", () => ({
  PageLoading: () => <div data-testid="page-skeleton" />,
}));

import { PageLoading } from "@/ui/page-skeleton";
import WorkspaceLayout from "./layout";

async function render(org: string, ws: string) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(
    <WorkspaceLayout params={Promise.resolve({ org, ws })}>
      <main data-testid="page">page</main>
    </WorkspaceLayout>,
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

describe("WorkspaceLayout", () => {
  it("resolves the viewer for the organization and the workspace slug", async () => {
    await render("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
  });

  it("renders the page for a member of the workspace", async () => {
    const { html, errors } = await render("acme", "core-platform");
    expect(html).toContain('data-testid="page"');
    expect(errors).toEqual([]);
  });

  it("mounts the creation wizards' host with the viewer's workspace", async () => {
    const { html } = await render("acme", "core-platform");
    expect(html).toContain('data-testid="create-host"');
    expect(CreateHost.mock.calls[0]?.[0]).toMatchObject({
      org: "acme",
      ws: "core-platform",
      wsName: "Core platform",
    });
  });

  it("draws the page skeleton, not nothing, while the viewer resolves", () => {
    const gate = WorkspaceLayout({
      children: null,
      params: Promise.resolve({ org: "acme", ws: "core-platform" }),
    }) as ReactElement<{ fallback: ReactElement }>;
    expect(gate.type).toBe(Suspense);
    expect(gate.props.fallback.type).toBe(PageLoading);
  });

  it("is not found for a non-member workspace slug, and the page never renders", async () => {
    const { html, errors } = await render("acme", "finops");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFound);
    // The child is named by its test id, not by its text: React puts the
    // component stack in the error template, and that stack carries absolute
    // file paths, so a bare substring matches whatever the checkout is called.
    expect(html).not.toContain('data-testid="page"');
    expect(html).not.toContain('data-testid="create-host"');
  });
});
