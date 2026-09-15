import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { ShellChrome, ShellFrame } from "@/features/shell";
import { requireViewer } from "@/server/viewer";

// The organization shell: sidebar, top bar, command menu and <MobileNav>
// around every organization and workspace page. The frame is static; the
// chrome awaits the route params and resolves the viewer inside the frame's
// <Suspense>, so the static shell still prerenders and a stranger is a 404
// before the chrome renders. Each page resolves its own viewer, inside the
// <Suspense> around the page (params of an unlisted slug are request data).
export default function OrganizationLayout({
  children,
  params,
}: LayoutProps<"/[org]">) {
  return (
    <ShellFrame chrome={<OrganizationChrome params={params} />}>
      <Suspense fallback={null}>{children}</Suspense>
    </ShellFrame>
  );
}

async function OrganizationChrome({
  params,
}: {
  params: LayoutProps<"/[org]">["params"];
}) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return <ShellChrome ctx={ctx} source={dataSource()} />;
}
