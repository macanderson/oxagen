export interface McpServerSummary {
  publicId: string;
  name: string;
  toolCount: number;
  healthStatus: "healthy" | "degraded" | "unreachable";
}
