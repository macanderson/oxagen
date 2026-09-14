import { ShellChrome, ShellFrame } from "@/features/shell";

// The organization shell: sidebar, top bar, command menu, notifications,
// Account dialog, assistant flyout and <MobileNav> around every organization and
// workspace page. The frame is static; the chrome awaits the route params inside
// the frame's <Suspense>, so the static shell still prerenders.
export default function OrganizationLayout({
  children,
  params,
}: LayoutProps<"/[org]">) {
  return (
    <ShellFrame chrome={<ShellChrome params={params} />}>{children}</ShellFrame>
  );
}
