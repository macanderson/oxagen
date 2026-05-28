export * from "./env.js";

export const PORTS = {
  app: 3000,
  website: 3100,
  api: 4000,
  mcp: 4100,
} as const;

export type AppName = keyof typeof PORTS;
