import { Suspense } from "react";
import { NewOrganizationScreen } from "@/features/onboarding";
import { AuthShell, AuthSkeleton } from "@/ui/auth-shell";

// Create an organization: the address the deprecated app, the docs and the
// GitHub setup fallback use. The form is the whole page.
export default function NewOrganizationPage() {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <NewOrganizationScreen />
      </Suspense>
    </AuthShell>
  );
}
