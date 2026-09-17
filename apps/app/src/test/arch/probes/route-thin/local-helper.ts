import { handleAuthRequest } from "@/features/auth";

function trace(request: Request): void {
  console.log(request.url);
}

export const GET = (request: Request) => handleAuthRequest(request);
