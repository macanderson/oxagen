import { fleet } from "@/features/fleet";

export default async function Page({ params }: PageProps<"/[org]/probe">) {
  const { org } = await params;
  return fleet(org);
}
