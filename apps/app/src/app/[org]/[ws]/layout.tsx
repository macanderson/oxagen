import { Suspense } from "react";
import { WorkspaceGuard } from "@/features/shell";

// The workspace shell. The chrome itself lives in the organization layout, which
// persists across workspace switches so the assistant flyout and a half-typed
// message survive navigation; this layer guards the workspace slug (an unknown
// workspace is a 404, like an unknown organization) inside its own <Suspense>.
export default function WorkspaceLayout({
  children,
  params,
}: LayoutProps<"/[org]/[ws]">) {
  return (
    <>
      <Suspense fallback={null}>
        <WorkspaceGuard params={params} />
      </Suspense>
      {children}
    </>
  );
}
