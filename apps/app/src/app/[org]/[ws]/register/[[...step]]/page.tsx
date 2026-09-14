import { Suspense } from "react";
import { GateSkeleton, RegisterScreen } from "@/features/onboarding";

// Register an agent from Fleet: name → wrap → wait for the first frame, on the
// same wrap and first-frame screens as the onboarding gate.
export default function RegisterPage(
  props: PageProps<"/[org]/[ws]/register/[[...step]]">,
) {
  return (
    <Suspense fallback={<GateSkeleton />}>
      <RegisterScreen params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}
