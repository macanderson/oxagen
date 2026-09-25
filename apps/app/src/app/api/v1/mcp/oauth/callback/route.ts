import { handleMcpOAuthCallback } from "@/features/tools";
export const GET = (request: Request): Promise<Response> =>
  handleMcpOAuthCallback(request);
