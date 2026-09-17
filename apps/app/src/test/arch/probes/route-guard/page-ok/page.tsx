import { fleet } from "@/features/fleet";
import { requireViewer } from "@/server/viewer";

export default async function Page({ params }: PageProps<"/[org]/[ws]/probe">) {
  const { org, ws } = await params;
  const ctx = await requireViewer(org, ws);
  return fleet(ctx);
}
