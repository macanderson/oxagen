import { getToken, getApiUrl } from "./config.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const base = getApiUrl();
  const url = `${base}/api/v1${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

export function requireAuth(): void {
  if (!getToken()) {
    console.error("Error: not authenticated. Run `oxagen auth login` first.");
    process.exit(1);
  }
}
