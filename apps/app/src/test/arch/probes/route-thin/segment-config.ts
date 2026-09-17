import { handleRunStream, resolveViewer, source } from "@/features/run";

export const maxDuration = 320;
export const dynamic = "force-dynamic";

export const GET = (request: Request, params: unknown): Promise<Response> =>
  handleRunStream(request, params, { resolveViewer, source });
