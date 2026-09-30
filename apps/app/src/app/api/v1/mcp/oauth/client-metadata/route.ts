import { handleMcpOAuthClientMetadata } from "@/features/tools";
export const GET = (request: Request): Promise<Response> =>
  handleMcpOAuthClientMetadata(request);
