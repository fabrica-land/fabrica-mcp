// Minimal Ethereum JSON-RPC reads for get_transaction_status and the sign-request result check.
// Reads only: the server never signs or broadcasts. FABRICA_RPC_URL overrides the public node.
import { z } from "zod";
import { IS_MAINNET } from "../config.js";

const DEFAULT_RPC_URL = IS_MAINNET ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_TIMEOUT_MS = 10_000;

export const CHAIN_ID = IS_MAINNET ? 1 : 11155111;
export const EXPLORER_URL = IS_MAINNET ? "https://etherscan.io" : "https://sepolia.etherscan.io";

const rpcResponse = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const transactionSchema = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  value: z.string(),
  blockNumber: z.string().nullable(),
});
export type RpcTransaction = z.infer<typeof transactionSchema>;

const receiptSchema = z.object({
  status: z.string().nullable().optional(),
  blockNumber: z.string(),
  gasUsed: z.string(),
});
export type RpcReceipt = z.infer<typeof receiptSchema>;

async function call(method: string, params: readonly unknown[]): Promise<unknown> {
  const url = process.env.FABRICA_RPC_URL ?? DEFAULT_RPC_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`The Ethereum node did not respond within ${RPC_TIMEOUT_MS / 1000} s. Try again shortly.`);
    }
    throw error;
  }
  const body = rpcResponse.safeParse(await response.json().catch(() => null));
  if (!response.ok || !body.success) throw new Error(`The Ethereum node request failed (HTTP ${response.status}). Try again shortly.`);
  if (body.data.error) throw new Error(`The Ethereum node refused the request: ${body.data.error.message}`);
  return body.data.result;
}

export async function getTransaction(hash: string): Promise<RpcTransaction | null> {
  const result = await call("eth_getTransactionByHash", [hash]);
  return result == null ? null : transactionSchema.parse(result);
}

export async function getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
  const result = await call("eth_getTransactionReceipt", [hash]);
  return result == null ? null : receiptSchema.parse(result);
}

export async function getBlockNumber(): Promise<number> {
  const result = z.string().parse(await call("eth_blockNumber", []));
  return Number.parseInt(result, 16);
}
