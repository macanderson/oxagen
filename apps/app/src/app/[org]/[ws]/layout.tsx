import { type ReactNode, Suspense } from "react";
import { dataSource } from "@/data/source";
import { CreateHost } from "@/features/create";
import { ShellWorkspace, WorkspaceDenied } from "@/features/shell";
import { resolveWorkspaceViewer } from "@/server/viewer";
import { PageSkeleton } from "@/ui/page-states";

// The workspace layer of the shell. The chrome lives in the organization
// layout, which persists across workspace switches; this layer resolves the
// viewer for the workspace slug itself. A signed-in member of the organization
// who is not a member of the workspace, or a slug that does not exist, gets the
// denied state in place of the page, inside the shell, and no page under the
// workspace renders (audit-prompt check 22). The two read the same, so the
// page confirms nothing about a workspace the viewer cannot see. The check
// runs inside its own <Suspense> because params of an unlisted slug are request
// data (Cache Components), and it wraps the page so nothing renders ahead of
// it; while it resolves, the page body is the shared skeleton.
// Once the viewer resolves, the layer also mounts the creation wizards' host
// (roadmap creation-spec §1): every workspace page can open a wizard over
// itself, and ⌘K Create reaches the same one. It also reads what waits in this
// workspace (the sidebar's counts and the bell's feed) for the chrome, which
// sits in the organization layout and cannot see the workspace slug; that
// read streams in its own <Suspense> so it never holds the page.
export default function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/[org]/[ws]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkspaceGate params={params}>{children}</WorkspaceGate>
    </Suspense>
  );
}

async function WorkspaceGate({
  children,
  params,
}: {
  children: ReactNode;
  params: LayoutProps<"/[org]/[ws]">["params"];
}) {
  const { org, ws } = await params;
  const viewer = await resolveWorkspaceViewer(org, ws);
  if (viewer.kind === "refused")
    return <WorkspaceDenied ctx={viewer.ctx} ws={ws} source={dataSource()} />;
  const { ctx } = viewer;
  return (
    <>
      {children}
      <CreateHost org={ctx.orgSlug} ws={ctx.wsSlug} wsName={ctx.wsName} />
      <Suspense fallback={null}>
        <ShellWorkspace ctx={ctx} source={dataSource()} />
      </Suspense>
    </>
  );
}
