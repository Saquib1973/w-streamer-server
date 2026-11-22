import { AppError } from "./errors.js";
import type { ErrorCode } from "../contracts/api.js";

export interface FetchJsonOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Error code used for network / non-2xx failures. */
  errorCode?: ErrorCode;
  /** Label used in error messages, e.g. addon name. */
  label?: string;
}

const UA = "W-Streamer/0.1 (+self-hosted)";

export class UpstreamHttpError extends AppError {
  constructor(code: ErrorCode, message: string, readonly upstreamStatus: number | null, readonly upstreamBody?: unknown) {
    super(code, message, upstreamStatus ? { upstreamStatus } : undefined);
  }
}

export async function fetchJson<T = unknown>(url: string, o: FetchJsonOptions = {}): Promise<T> {
  const code = o.errorCode ?? "ADDON_UNREACHABLE";
  const label = o.label ?? new URL(url).host;
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json", ...o.headers };
  let body: string | undefined;
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: o.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new UpstreamHttpError(code, `${label}: ${timeout ? "timed out" : "unreachable"}`, null);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.ok) throw new UpstreamHttpError(code, `${label}: response is not JSON`, res.status);
    }
  }
  if (!res.ok) throw new UpstreamHttpError(code, `${label}: HTTP ${res.status}`, res.status, parsed);
  return parsed as T;
}
