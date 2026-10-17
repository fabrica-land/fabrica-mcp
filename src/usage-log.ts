import type { ServerResponse } from "node:http";
import { NETWORK } from "./config.js";

/**
 * One structured log line per HTTP request, for the usage read (docs/usage/).
 * It records what was called and how it ended, never who called: no arguments,
 * no wallet addresses, no IPs. Vercel keeps stdout as the function's runtime logs.
 */

const MAX_FIELD_CHARS = 120;
const MAX_SNIFF_BYTES = 64 * 1024;

export interface UsageCall {
  method: string;
  tool?: string;
  client?: string;
}

export type UsageOutcome = "ok" | "tool_error" | "rpc_error" | "http_error" | "aborted";

export interface UsageLine {
  event: "mcp_request";
  network: string;
  calls: UsageCall[];
  userAgent?: string;
  status: number;
  outcome: UsageOutcome;
  durationMs: number;
}

function clip(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

/** Client-controlled text can carry identifiers: hex runs (wallets, keys), IPs and emails are replaced. */
export function scrub(value: string): string {
  return value.replace(/0x[0-9a-f]{6,}|[0-9a-f]{16,}|\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){3,}|[^\s@/]+@[^\s@/]+\.[a-z]{2,}/gi, "[redacted]");
}

/** JSON-RPC methods worth naming in the read; anything else is logged as "other". */
const KNOWN_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "prompts/list", "prompts/get", "resources/list", "resources/read", "resources/templates/list", "completion/complete", "logging/setLevel", "notifications/cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeMessage(message: unknown): UsageCall | undefined {
  if (!isRecord(message)) return undefined;
  const rawMethod = clip(message.method);
  if (!rawMethod) return undefined;
  const method = KNOWN_METHODS.has(rawMethod) ? rawMethod : "other";
  const params = isRecord(message.params) ? message.params : {};
  // Tool names are lowercase words joined by underscores; anything else is not a tool of ours.
  const rawTool = method === "tools/call" ? clip(params.name) : undefined;
  const tool = rawTool === undefined ? undefined : /^[a-z][a-z_]{0,63}$/.test(rawTool) ? rawTool : "other";
  const clientInfo = method === "initialize" && isRecord(params.clientInfo) ? params.clientInfo : undefined;
  const rawClient = clientInfo ? clip([clientInfo.name, clientInfo.version].filter((part) => typeof part === "string").join("/")) : undefined;
  const client = rawClient === undefined ? undefined : scrub(rawClient);
  return { method, ...(tool ? { tool } : {}), ...(client ? { client } : {}) };
}

/** Methods, tool names and initialize clientInfo from a JSON-RPC message or batch. Nothing else. */
export function describeRequest(body: unknown): UsageCall[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.slice(0, 10).map(describeMessage).filter((call): call is UsageCall => call !== undefined);
}

/** Classifies the response from its status and the start of its JSON body. */
export function classifyOutcome(status: number, responseStart: string): UsageOutcome {
  if (status >= 400) return "http_error";
  if (/"error"\s*:\s*\{/.test(responseStart)) return "rpc_error";
  if (/"isError"\s*:\s*true/.test(responseStart)) return "tool_error";
  return "ok";
}

export function formatUsageLine(line: UsageLine): string {
  return JSON.stringify(line);
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

/**
 * Records the start of the response body as it is written and logs one line when
 * the response finishes. Call before anything is written to `res`.
 */
export function trackUsage(res: ServerResponse, userAgent: string | undefined, started: number = Date.now()): (calls: UsageCall[]) => void {
  let sniffed = "";
  let calls: UsageCall[] = [];
  const capture = (chunk: unknown): void => {
    if (sniffed.length < MAX_SNIFF_BYTES) sniffed += chunkToString(chunk).slice(0, MAX_SNIFF_BYTES - sniffed.length);
  };
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  Object.assign(res, {
    write: (chunk: unknown, ...rest: unknown[]): boolean => {
      capture(chunk);
      return Reflect.apply(originalWrite, res, [chunk, ...rest]);
    },
    end: (chunk?: unknown, ...rest: unknown[]): ServerResponse => {
      if (typeof chunk !== "function") capture(chunk);
      return Reflect.apply(originalEnd, res, [chunk, ...rest]);
    },
  });
  let logged = false;
  const finalize = (): void => {
    if (logged) return;
    logged = true;
    const clipped = clip(userAgent);
    const ua = clipped === undefined ? undefined : scrub(clipped);
    console.log(formatUsageLine({
      event: "mcp_request",
      network: NETWORK,
      calls,
      ...(ua ? { userAgent: ua } : {}),
      status: res.statusCode,
      outcome: res.writableFinished ? classifyOutcome(res.statusCode, sniffed) : "aborted",
      durationMs: Date.now() - started,
    }));
  };
  // A client that disconnects mid-call fires `close` without `finish`; that call is still counted.
  res.once("finish", finalize);
  res.once("close", finalize);
  return (parsed) => {
    calls = parsed;
  };
}
