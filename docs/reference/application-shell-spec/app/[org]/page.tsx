import { redirect } from "next/navigation"

export default async function OrgRoot({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params
  redirect(`/${org}/workspaces`)
}
