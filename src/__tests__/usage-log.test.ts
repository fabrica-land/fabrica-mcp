import { createServer as createHttpServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest } from "../http.js";
import { classifyOutcome, describeRequest, scrub, trackUsage, type UsageLine } from "../usage-log.js";

function isUsageLine(value: unknown): value is UsageLine {
  return typeof value === "object" && value !== null && "event" in value && value.event === "mcp_request";
}

function usageLines(spy: { mock: { calls: unknown[][] } }): UsageLine[] {
  return spy.mock.calls.flatMap(([first]) => {
    if (typeof first !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(first);
      return isUsageLine(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

describe("describeRequest", () => {
  it("keeps the method, tool name and client, never the arguments", () => {
    const calls = describeRequest([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-ai", version: "1.2" }, capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_portfolio", arguments: { wallet: "0xabc" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(calls).toEqual([
      { method: "initialize", client: "claude-ai/1.2" },
      { method: "tools/call", tool: "get_portfolio" },
      { method: "notifications/initialized" },
    ]);
    expect(JSON.stringify(calls)).not.toContain("0xabc");
  });

  it("keeps client-controlled identifiers out of the line", () => {
    const calls = describeRequest([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agent 0x1234567890abcdef1234 from 203.0.113.9", version: "me@example.com" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "0xdeadbeefdeadbeef" } },
      { jsonrpc: "2.0", id: 3, method: "custom/0xdeadbeef" },
    ]);
    const raw = JSON.stringify(calls);
    expect(raw).not.toContain("1234567890abcdef");
    expect(raw).not.toContain("203.0.113.9");
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("deadbeef");
    expect(calls[1]).toEqual({ method: "tools/call", tool: "other" });
    expect(calls[2]).toEqual({ method: "other" });
    expect(scrub("claude-ai/1.0 (darwin)")).toBe("claude-ai/1.0 (darwin)");
  });

  it("ignores bodies that are not JSON-RPC", () => {
    expect(describeRequest(undefined)).toEqual([]);
    expect(describeRequest({ hello: "world" })).toEqual([]);
  });
});

describe("classifyOutcome", () => {
  it("separates HTTP, JSON-RPC and tool errors", () => {
    expect(classifyOutcome(413, "")).toBe("http_error");
    expect(classifyOutcome(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32602}}')).toBe("rpc_error");
    expect(classifyOutcome(200, '{"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":true}}')).toBe("tool_error");
    expect(classifyOutcome(200, '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')).toBe("ok");
  });
});

describe("trackUsage", () => {
  it("still logs one line, marked aborted, when the client disconnects before the response", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    trackUsage(res, "test-agent")([{ method: "tools/call", tool: "get_property" }]);
    res.emit("close");
    res.emit("close");
    const lines = usageLines(spy);
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("aborted");
    expect(lines[0]?.calls[0]?.tool).toBe("get_property");
  });

  it("finds an error after a large result, even when the marker is split across writes", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = createHttpServer((_req, res) => {
      trackUsage(res, "test-agent")([{ method: "tools/call", tool: "get_property_image" }, { method: "tools/call", tool: "get_property" }]);
      res.write(`[{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"${"A".repeat(200_000)}"}]}},`);
      res.write('{"jsonrpc":"2.0","id":2,"result":{"content":[],"isEr');
      res.end('ror":true}}]');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vi.waitFor(() => expect(usageLines(spy)).toHaveLength(1));
    const lines = usageLines(spy);
    spy.mockRestore();
    expect(lines[0]?.outcome).toBe("tool_error");
  });
});

describe("usage log line over HTTP", () => {
  let httpServer: Server;
  let url: string;

  beforeAll(async () => {
    httpServer = createHttpServer((req, res) => void handleMcpHttpRequest(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("logs one line per request with the client, tool and outcome, and nothing personal", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = new Client({ name: "usage-test", version: "9.9.9" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    await client.listTools();
    await client.callTool({ name: "get_portfolio", arguments: { wallet: "not-a-wallet-0xdeadbeef" } });
    await client.close();
    await vi.waitFor(() => expect(usageLines(spy).some((line) => line.calls.some((call) => call.tool === "get_portfolio"))).toBe(true));
    const lines = usageLines(spy);
    spy.mockRestore();
    expect(lines.find((line) => line.calls.some((call) => call.method === "initialize"))?.calls[0]?.client).toBe("usage-test/9.9.9");
    const list = lines.find((line) => line.calls.some((call) => call.method === "tools/list"));
    expect(list?.outcome).toBe("ok");
    expect(list?.status).toBe(200);
    const call = lines.find((line) => line.calls.some((entry) => entry.tool === "get_portfolio"));
    expect(call?.outcome).not.toBe("ok");
    for (const line of lines) {
      const raw = JSON.stringify(line);
      expect(raw).not.toContain("deadbeef");
      expect(raw).not.toContain("127.0.0.1");
      expect(Buffer.byteLength(raw)).toBeLessThan(1024);
    }
  });
});
