import { fleet } from "@/features/fleet";
import { requireViewer } from "@/server/viewer";

export default async function Page({ params }: PageProps<"/[org]/[ws]/probe">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return fleet(ctx);
}
