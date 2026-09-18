// The workspace layout is the guard for every page under /[org]/[ws]: it
// resolves the viewer for both slugs through requireViewer and renders the page
// only once that resolves. The shell's reads are not imported here, so a
// failing shell context read cannot let a non-member through (F3).
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { NotFound, requireViewer } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
  requireViewer: vi.fn((org: string, ws?: string) => {
    if (org === "acme" && ws === "core-platform")
      return Promise.resolve({ userId: "u1" });
    return Promise.reject(new NotFound("NEXT_NOT_FOUND"));
  }),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));

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

  it("is not found for a non-member workspace slug, and the page never renders", async () => {
    const { html, errors } = await render("acme", "finops");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFound);
    // The child is named by its test id, not by its text: React puts the
    // component stack in the error template, and that stack carries absolute
    // file paths, so a bare substring matches whatever the checkout is called.
    expect(html).not.toContain('data-testid="page"');
  });
});
