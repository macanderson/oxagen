// /new-organization as a Server Component: the signed-in person, then the
// organization form. A signed-out visitor is sent to /login and back here. The
// route renders the column and its PageHeader around this screen.
import { requireUser } from "@/server/viewer";
import { readNext, routes } from "@/shared/safe-path";
import { OrganizationForm } from "./ui/organization-form";

export async function NewOrganizationScreen({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Where a created organization continues to. /cli/authorize sends a new
  // account here with itself as the destination, so the CLI's PKCE round trip
  // finishes; with none, the form lands on the new workspace's Fleet page.
  const next = readNext(await searchParams);
  await requireUser(routes.newOrganization(next));
  return (
    <OrganizationForm destination={next === routes.root() ? undefined : next} />
  );
}
