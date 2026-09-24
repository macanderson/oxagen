import { Suspense } from "react";
import { redirectTo } from "@/shared/navigation";
import { readNext, routes } from "@/shared/safe-path";

// The design names onboarding step 1 `/welcome/organization`. The page lives at
// /new-organization, the address sign-up, the CLI, the docs and the GitHub
// setup fallback already use, so this one forwards there with its `?next=`.
// The query is request data, so the forward reads it inside <Suspense> (Cache
// Components) and the route's static shell still prerenders.
export default function WelcomeOrganizationPage(
  props: PageProps<"/welcome/organization">,
) {
  return (
    <Suspense fallback={null}>
      <ForwardToNewOrganization searchParams={props.searchParams} />
    </Suspense>
  );
}

async function ForwardToNewOrganization({
  searchParams,
}: {
  searchParams: PageProps<"/welcome/organization">["searchParams"];
}): Promise<null> {
  const next = readNext(await searchParams);
  return redirectTo(routes.newOrganization(next));
}
