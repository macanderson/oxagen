import { handleRunStream } from "@/features/run";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return handleRunStream(request, { run: url.searchParams.get("run") });
}
