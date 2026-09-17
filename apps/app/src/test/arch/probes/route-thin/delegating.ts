import { handleAuthRequest } from "@/features/auth";

export function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}
