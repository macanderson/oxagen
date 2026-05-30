import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewOrgForm } from "@/components/org/new-organization-form";
import { getSessionOrRedirect } from "@/lib/session";
import { createOrgAction } from "./actions";

export default async function NewTenantPage() {
  await getSessionOrRedirect();
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Create your first organization</CardTitle>
          <CardDescription>
            Organizations own billing and member access. A default workspace is created for you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewOrgForm action={createOrgAction} />
        </CardContent>
      </Card>
    </div>
  );
}
