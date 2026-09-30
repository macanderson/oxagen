// Every [org] route module resolves its viewer (INV-01). The organization
// layout above already resolved it inside its <Suspense>, and requireViewer
// is cached for the request, so this costs no second read. The shell frame
// owns the page's <main id="main"> (ADR-227), so this layout adds no element.
import { requireViewer } from "@/server/viewer";

export default async function BillingLayout({
  children,
  params,
}: LayoutProps<"/[org]/billing">) {
  const { org } = await params;
  await requireViewer(org);
  return children;
}
