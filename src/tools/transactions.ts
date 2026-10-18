// get_transaction_status: follows a transaction the person's own wallet sent (a purchase from a
// sign link, a loan, a repayment). Reads the chain only; the server never broadcasts.
import { z } from "zod";
import { EXPLORER_URL, getBlockNumber, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import { NETWORK_LABEL } from "../config.js";
import { type ArgsOf } from "./inputs.js";

export const getTransactionStatusInput = {
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "A 0x-prefixed 32-byte transaction hash").describe("The transaction hash (0x followed by 64 hex characters)"),
};
export type GetTransactionStatusArgs = ArgsOf<typeof getTransactionStatusInput>;

export async function getTransactionStatus({ hash }: GetTransactionStatusArgs) {
  try {
    const [transaction, receipt, head] = await Promise.all([getTransaction(hash), getTransactionReceipt(hash), getBlockNumber()]);
    const explorer = `${EXPLORER_URL}/tx/${hash}`;
    if (!transaction) {
      return {
        network: NETWORK_LABEL,
        hash,
        status: "not_found",
        note: `The network does not know this transaction. It may not have been sent yet, it may have been dropped, or it was sent on another network (this server reads ${NETWORK_LABEL}).`,
        explorer,
      };
    }
    const base = { network: NETWORK_LABEL, hash, from: transaction.from, to: transaction.to, explorer };
    if (!receipt) return { ...base, status: "pending", note: "Sent and waiting to be included in a block." };
    const block = Number.parseInt(receipt.blockNumber, 16);
    const confirmations = Math.max(0, head - block + 1);
    const succeeded = receipt.status === "0x1";
    return {
      ...base,
      status: succeeded ? "succeeded" : "failed",
      blockNumber: block,
      confirmations,
      note: succeeded
        ? `Included in block ${block} with ${confirmations} confirmation${confirmations === 1 ? "" : "s"}.`
        : "Included in a block but reverted: it changed nothing onchain except the network fee. The explorer link shows the reason when there is one.",
    };
  } catch (e) {
    return { error: `Failed to read the transaction: ${e instanceof Error ? e.message : String(e)}` };
  }
}
