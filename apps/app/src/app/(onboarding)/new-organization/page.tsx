import { Suspense } from "react";
import { NewOrganizationScreen } from "@/features/onboarding";
import { AuthShell, AuthSkeleton } from "@/ui/auth-shell";

// Create an organization: the address the deprecated app, the docs and the
// GitHub setup fallback use. The form is the whole page. `?next=` (or the
// CLI's `?returnTo=`) is where a created organization continues to: the CLI
// consent page for an account made during `oxagen auth login`.
export default function NewOrganizationPage(
  props: PageProps<"/new-organization">,
) {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <NewOrganizationScreen searchParams={props.searchParams} />
      </Suspense>
    </AuthShell>
  );
}
