import { fleet } from "@/features/fleet";
import { requireViewer } from "./fake";

export default async function Page({ params }: PageProps<"/[org]/probe">) {
  const { org } = await params;
  const ctx = await requireViewer(org);
  return fleet(ctx);
}
