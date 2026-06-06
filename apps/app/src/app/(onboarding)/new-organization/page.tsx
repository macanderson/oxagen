import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewOrgForm } from "@/components/org/new-organization-form";
import { getSessionOrRedirect } from "@/lib/session";
import { createOrgAction } from "./actions";

export default async function NewTenantPage() {
  await getSessionOrRedirect();
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
          <NewOrgForm action={createOrgAction} />
        </CardPanel>
      </Card>
    </div>
  );
}
