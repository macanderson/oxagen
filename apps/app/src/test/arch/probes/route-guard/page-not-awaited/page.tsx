import { fleet } from "@/features/fleet";
import { requireViewer } from "@/server/viewer";

export default async function Page({ params }: PageProps<"/[org]/probe">) {
  const { org } = await params;
  const ctx = requireViewer(org);
  return fleet(ctx);
}
