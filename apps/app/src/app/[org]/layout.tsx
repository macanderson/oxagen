import { type ReactNode, Suspense } from "react";
import { dataSource } from "@/data/source";
import { SignedInNotice } from "@/features/auth";
import { ShellChrome, ShellFrame, ViewerClock } from "@/features/shell";
import { requireViewer } from "@/server/viewer";
import { PageLoading } from "@/ui/page-skeleton";

// The organization shell: sidebar, top bar, command menu and <MobileNav>
// around every organization and workspace page. The frame is static; the
// chrome awaits the route params and resolves the viewer inside the frame's
// <Suspense>, so the static shell still prerenders and a stranger is a 404
// before the chrome renders. Each page resolves its own viewer, inside the
// <Suspense> around the page (params of an unlisted slug are request data).
// Inside that same <Suspense>, <OrganizationClock> resolves the viewer's time
// zone and every date on the page renders in it. <SignedInNotice> shows
// "Signed in as …" once on the first page a sign-in lands on. While the viewer
// resolves, that <Suspense> draws the page skeleton inside the frame, so the
// chrome stays and a click shows the page's shape at once.
export default function OrganizationLayout({
  children,
  params,
}: LayoutProps<"/[org]">) {
  return (
    <ShellFrame chrome={<OrganizationChrome params={params} />}>
      <Suspense fallback={<PageLoading />}>
        <OrganizationClock params={params}>{children}</OrganizationClock>
      </Suspense>
    </ShellFrame>
  );
}

async function OrganizationClock({
  children,
  params,
}: {
  children: ReactNode;
  params: LayoutProps<"/[org]">["params"];
}) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return (
    <ViewerClock ctx={ctx} source={dataSource()}>
      {children}
      <SignedInNotice />
    </ViewerClock>
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
