import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewOrgForm } from "@/components/org/new-organization-form";
import { getSessionOrRedirect } from "@/lib/session";
import { getLinkedSocialProvider } from "@/lib/linked-provider";
import { buildOrgSignupPrefill } from "@/lib/oauth-prefill";
import { createOrgAction } from "./actions";

export default async function NewTenantPage() {
  const session = await getSessionOrRedirect();

  // Seed the form from the signed-in user's profile. Better Auth populates
  // name / email / avatar from the Google or GitHub OAuth profile at sign-in;
  // we look up which social provider is linked so the form can attribute the
  // prefilled values ("Prefilled from your Google account").
  const provider = await getLinkedSocialProvider(session.user.id);
  const prefill = buildOrgSignupPrefill({
    name: session.user.name,
    email: session.user.email,
    image: session.user.image,
    provider,
  });

  return (
    <div className="flex min-h-dvh items-start justify-center p-4 py-8">
      <Card className="w-full max-w-3xl">
        <CardHeader>
          <CardTitle>Create organization</CardTitle>
          <CardDescription>
            Organizations own billing and member access. A default workspace is created for you.
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <NewOrgForm action={createOrgAction} prefill={prefill} />
        </CardPanel>
      </Card>
    </div>
  );
}
