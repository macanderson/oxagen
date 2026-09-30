declare module "xmcp-adapter-runtime" {
  import type { Request, Response } from "express";
  export function xmcpHandler(req: Request, res: Response): Promise<unknown>;
}

declare module "xmcp-home-template" {
  export default function homeTemplate(
    endpoint: string,
    serverName: string | undefined,
    serverDescription: string | undefined,
  ): string;
}
