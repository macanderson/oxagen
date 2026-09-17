import { handleRunStream } from "@/features/run";

export const maxDuration = 300 + 20;
export const GET = (request: Request) => handleRunStream(request);
