import { handleAuthRequest } from "@/features/auth";

export const GET = (request: Request) => fetch(request);
export const POST = (request: Request) => handleAuthRequest(request);
