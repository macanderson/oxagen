// The workspace layout is the guard for every page under /[org]/[ws]: it
// resolves the viewer for both slugs through resolveWorkspaceViewer and renders
// the page only once that admits the viewer. A workspace it refuses draws the
// denied state in place of the page, inside the shell. The shell's workspace reads (the sidebar's counts
// and the bell's feed) run only after it resolves, with the viewer it
// resolved, so a failing shell read cannot let a non-member through (F3).
// The steering repo health banner reads `get_steering_repo` through the same
// data source, also only after the gate admits the viewer. A refused viewer
// never reaches it, so a denied page makes no steering repo read.
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const {
  NotFound,
  resolveWorkspaceViewer,
  CreateHost,
  ShellWorkspace,
  WorkspaceDenied,
  SteeringRepoHealthBanner,
  source,
} = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
  resolveWorkspaceViewer: vi.fn((org: string, ws: string) => {
    if (org !== "acme") return Promise.reject(new NotFound("NEXT_NOT_FOUND"));
    if (ws === "core-platform")
      return Promise.resolve({
        kind: "ok",
        ctx: {
          userId: "u1",
          orgSlug: "acme",
          wsSlug: "core-platform",
          wsName: "Core platform",
        },
      });
    return Promise.resolve({
      kind: "refused",
      ctx: { userId: "u1", orgSlug: "acme" },
    });
  }),
  WorkspaceDenied: vi.fn((props: { ws: string }) => (
    <div data-testid="workspace-denied" data-ws={props.ws} />
  )),
  CreateHost: vi.fn((props: { org: string; ws: string; wsName: string }) => (
    <div data-testid="create-host" data-ws={props.ws} />
  )),
  ShellWorkspace: vi.fn((props: { ctx: { wsSlug: string } }) => (
    <div data-testid="shell-workspace" data-ws={props.ctx.wsSlug} />
  )),
  SteeringRepoHealthBanner: vi.fn((props: { ctx: { wsSlug: string } }) => (
    <div data-testid="steering-repo-health-banner" data-ws={props.ctx.wsSlug} />
  )),
  source: { shell: {} },
}));
vi.mock("@/server/viewer", () => ({ resolveWorkspaceViewer }));
vi.mock("@/features/create", () => ({ CreateHost }));
vi.mock("@/features/shell", () => ({ ShellWorkspace, WorkspaceDenied }));
vi.mock("@/features/steering-repo", () => ({ SteeringRepoHealthBanner }));
vi.mock("@/ui/page-states", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));

import WorkspaceLayout from "./layout";

async function render(org: string, ws: string) {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(
    <WorkspaceLayout params={Promise.resolve({ org, ws })}>
      <div data-testid="page">page</div>
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
    expect(resolveWorkspaceViewer).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
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

  it("reads the steering repo health with the viewer it resolved and the data source", async () => {
    const { html } = await render("acme", "core-platform");
    expect(html).toContain('data-testid="steering-repo-health-banner"');
    expect(SteeringRepoHealthBanner.mock.calls[0]?.[0]).toMatchObject({
      ctx: { wsSlug: "core-platform", orgSlug: "acme" },
      source,
    });
  });

  it("draws the denied state inside the shell for a workspace it refuses, and the page never renders (negative)", async () => {
    const { html, errors } = await render("acme", "finops");
    expect(errors).toEqual([]);
    expect(html).toContain('data-testid="workspace-denied"');
    expect(WorkspaceDenied.mock.calls.at(-1)?.[0]).toMatchObject({
      ws: "finops",
      ctx: { orgSlug: "acme" },
      source,
    });
    expect(html).not.toContain('data-testid="page"');
    expect(html).not.toContain('data-testid="create-host"');
    expect(html).not.toContain('data-testid="shell-workspace"');
    expect(html).not.toContain('data-testid="steering-repo-health-banner"');
  });

  it("is not found for an organization the viewer cannot see, and the page never renders (negative)", async () => {
    const { html, errors } = await render("globex", "core-platform");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFound);
    // The child is named by its test id, not by its text: React puts the
    // component stack in the error template, and that stack carries absolute
    // file paths, so a bare substring matches whatever the checkout is called.
    expect(html).not.toContain('data-testid="page"');
    expect(html).not.toContain('data-testid="workspace-denied"');
  });
});
