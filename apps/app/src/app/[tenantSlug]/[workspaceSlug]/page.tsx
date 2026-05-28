import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { resolveTenant, resolveWorkspace } from "@/lib/resolve-tenant";

export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ tenantSlug: string; workspaceSlug: string }>;
}) {
  const { tenantSlug, workspaceSlug } = await params;
  const tenant = await resolveTenant(tenantSlug);
  const workspace = await resolveWorkspace(tenant.id, workspaceSlug);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{workspace.name}</h1>
        <p className="text-sm text-muted-foreground">Your agent control surface.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Open the agent shell</CardTitle>
            <CardDescription>Stream a conversation with the workspace agent.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/${tenantSlug}/${workspaceSlug}/chat`}>Go to chat</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
            <CardDescription>Members, defaults, and graph routing.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/${tenantSlug}/${workspaceSlug}/settings`}>Manage</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
