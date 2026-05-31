import { permanentRedirect } from "next/navigation";

/**
 * Legacy route — permanently moved to /{orgSlug}/members
 * D-ws will add a proxy.ts-level redirect as well; this page-level redirect
 * handles any client navigations that haven't picked up the new URL yet.
 */
export default async function LegacyMembersRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  permanentRedirect(`/${orgSlug}/members`);
}
