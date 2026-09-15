import { type ReactNode, Suspense } from "react";
import { requireViewer } from "@/server/viewer";

// The workspace layer of the shell. The chrome lives in the organization
// layout, which persists across workspace switches; this layer resolves the
// viewer for the workspace slug itself. A signed-in person who is not a member
// of the workspace, or a slug that does not exist, is a 404 from the tenancy
// lookups before any page under the workspace renders. The check runs inside
// its own <Suspense> because params of an unlisted slug are request data
// (Cache Components), and it wraps the page so nothing renders ahead of it.
export default function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/[org]/[ws]">) {
  return (
    <Suspense fallback={null}>
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
  await requireViewer(org, ws);
  return children;
}
