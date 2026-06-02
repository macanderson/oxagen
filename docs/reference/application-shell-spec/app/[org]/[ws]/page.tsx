import { redirect } from "next/navigation"

export default async function WorkspaceRoot({
  params,
}: {
  params: Promise<{ org: string; ws: string }>
}) {
  const { org, ws } = await params
  redirect(`/${org}/${ws}/ask`)
}
