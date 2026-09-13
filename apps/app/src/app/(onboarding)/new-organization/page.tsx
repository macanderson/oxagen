import { Suspense } from "react";
import { GateSkeleton, WelcomeScreen } from "@/features/onboarding";

// Create an organization. The address the deprecated app, the docs and the
// GitHub setup fallback use; it renders the gate's first step in place.
export default function NewOrganizationPage(
  props: PageProps<"/new-organization">,
) {
  return (
    <Suspense fallback={<GateSkeleton />}>
      <WelcomeScreen
        params={Promise.resolve({})}
        searchParams={props.searchParams}
      />
    </Suspense>
  );
}
