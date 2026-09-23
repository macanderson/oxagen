// The workspace layout is the guard for every page under /[org]/[ws]: it
// resolves the viewer for both slugs through requireViewer and renders the page
// only once that resolves. The shell's workspace reads (the sidebar's counts
// and the bell's feed) run only after it resolves, with the viewer it
// resolved, so a failing shell read cannot let a non-member through (F3).
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { NotFound, requireViewer, CreateHost, ShellWorkspace, source } =
  vi.hoisted(() => ({
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
    ShellWorkspace: vi.fn((props: { ctx: { wsSlug: string } }) => (
      <div data-testid="shell-workspace" data-ws={props.ctx.wsSlug} />
    )),
    source: { shell: {} },
  }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/features/create", () => ({ CreateHost }));
vi.mock("@/features/shell", () => ({ ShellWorkspace }));
vi.mock("@/data/source", () => ({ dataSource: () => source }));

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

  it("reads the shell's workspace activity with the viewer it resolved and the data source", async () => {
    const { html } = await render("acme", "core-platform");
    expect(html).toContain('data-testid="shell-workspace"');
    expect(ShellWorkspace.mock.calls[0]?.[0]).toMatchObject({
      ctx: { wsSlug: "core-platform", orgSlug: "acme" },
      source,
    });
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
    expect(html).not.toContain('data-testid="shell-workspace"');
  });
});
