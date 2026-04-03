/** Supported networks */
export type FabricaNetwork = "ethereum" | "sepolia";

/** Resolve network from env var, default to ethereum mainnet */
function resolveNetwork(): FabricaNetwork {
  const env = process.env.FABRICA_NETWORK?.toLowerCase();
  if (env === "sepolia") return "sepolia";
  return "ethereum";
}

export const NETWORK: FabricaNetwork = resolveNetwork();

export const IS_MAINNET = NETWORK === "ethereum";

export const NETWORK_LABEL = IS_MAINNET ? "Ethereum Mainnet" : "Sepolia Testnet";

/** Contract addresses per network */
export const CONTRACTS = IS_MAINNET
  ? {
    fabricaToken: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    fabricaValidator: "0x170511f95560A1F280c29026f73a9cD6a4bA8ab0",
    nftfiV2: "0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207",
    nftfiV3: "0x9F10D706D789e4c76A1a6434cd1A9841c875C0A6",
  }
  : {
    fabricaToken: "0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD",
    fabricaValidator: "0xAAA7FDc1A573965a2eD47Ab154332b6b55098008",
    nftfiV2: null, // NFTfi is not available on Sepolia
    nftfiV3: null,
  };

// MetaStreet pool addresses are discovered dynamically from the subgraph
// by querying all pools that accept the Fabrica token as collateral.

/**
 * Legal disclaimer for mainnet operations.
 * Agents MUST relay this to their users when operating on mainnet.
 */
export const MAINNET_LEGAL_NOTICE = `IMPORTANT LEGAL NOTICE: You are operating on Ethereum Mainnet. Fabrica properties are real parcels of land in the United States, legally held in trust and controlled by ERC-1155 tokens. Actions performed through this MCP server — including acquiring, transferring, listing, or borrowing against tokens — have real-world legal consequences:

- Acquiring a Fabrica token makes you the beneficial owner of a real property trust. You accept the role of trustee under the trust instrument attached to the token.
- You may incur legal liabilities related to the real estate, including property taxes, maintenance obligations, and environmental liability.
- Transfers and sales are legally binding and may trigger tax events (capital gains, transfer taxes).
- You should review the operating agreement and trust instrument linked to any token before acquiring it. These documents are attached to the token and define your rights and obligations.
- This is not financial or legal advice. Consult qualified professionals for your jurisdiction.`;

/** Short version for embedding in tool responses */
export const MAINNET_WARNING = IS_MAINNET
  ? "This is MAINNET — operations have real-world legal and financial consequences. Review the trust instrument attached to any token before acquiring it."
  : null;
