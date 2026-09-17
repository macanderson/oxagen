import type { DataSource } from "@/data/ports";

const kernelRead = async () => ({ ok: true, value: [] });

export const approvals: DataSource["approvals"] = {
  pending: async () => kernelRead(),
};
