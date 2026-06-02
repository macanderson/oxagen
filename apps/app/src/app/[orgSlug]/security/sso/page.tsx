import { redirect } from "next/navigation";
import { org } from "@/lib/routes";

export default async function SecuritySsoPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(org.security.audit({ orgSlug }));
}
