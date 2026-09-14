import { requireViewer } from "@/server/viewer";

export default async function Layout({
  children,
  params,
}: LayoutProps<"/[org]">) {
  const p = await params;
  await requireViewer(p.org);
  return children;
}
