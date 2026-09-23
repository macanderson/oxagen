import { redirectTo } from "@/shared/navigation";
import { readNext, routes } from "@/shared/safe-path";

// The design names onboarding step 1 `/welcome/organization`. The page lives at
// /new-organization, the address sign-up, the CLI, the docs and the GitHub
// setup fallback already use, so this one forwards there with its `?next=`.
export default async function WelcomeOrganizationPage({
  searchParams,
}: PageProps<"/welcome/organization">) {
  const next = readNext(await searchParams);
  redirectTo(routes.newOrganization(next));
}
