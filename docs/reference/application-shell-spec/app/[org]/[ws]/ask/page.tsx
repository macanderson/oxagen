import { notFound } from "next/navigation"
import { getWorkspace } from "@/lib/mock-data"
import { AskSurface } from "@/components/shell/ask-surface"

export default async function AskPage({
  params,
}: {
  params: Promise<{ org: string; ws: string }>
}) {
  const { org, ws } = await params
  const wsData = getWorkspace(org, ws)
  if (!wsData) notFound()
  return <AskSurface workspaceName={wsData.name} />
}
