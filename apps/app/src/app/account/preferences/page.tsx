/**
 * Account Preferences page (RSC).
 *
 * Reads the user's preferences via the `user.preferences.read` capability
 * handler and renders the <PreferencesForm> client component.
 */
import { getSessionOrRedirect } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";
import type { CapabilityContext } from "@oxagen/oxagen";
import { PreferencesForm } from "./preferences-form";

export const metadata = {
  title: "Preferences — Oxagen",
};

export default async function AccountPreferencesPage() {
  const session = await getSessionOrRedirect();

  const ctx: CapabilityContext = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  const prefs = await userPreferencesReadHandler({}, ctx);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Preferences"
        description="Customize your interface appearance and agent behavior."
      />
      <PreferencesForm initial={prefs} />
    </div>
  );
}
