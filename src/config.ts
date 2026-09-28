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
    nftfiV2: null, // NFTfi (retired peer-to-peer integration) was never on Sepolia
    nftfiV3: null,
  };

// Lending pool addresses are discovered dynamically from the subgraph
// by querying all pools that accept the Fabrica token as collateral.

/**
 * Mainnet legal notice, carried in the server instructions. Written as a notice of
 * facts, not as directions to the model.
 */
export const MAINNET_LEGAL_NOTICE = `Legal notice (Ethereum Mainnet): Fabrica properties are real parcels of land in the United States. Each is held in a trust, and an ERC-1155 token represents the beneficial interest in that trust. Acquiring, transferring, listing or borrowing against a token has real-world legal and financial consequences:
- Owning a Fabrica token means owning the beneficial interest in the trust that holds the property. The trustee is designated by the token holder and is, by default, the holder.
- Owners can carry obligations tied to the land, such as property taxes, maintenance and environmental liability.
- Transfers and sales are legally binding and can trigger tax events such as capital gains or transfer taxes.
- The operating agreement (the trust instrument) attached to each token sets out the owner's rights and obligations. Its URL is included in property details.
- This data is informational and is not financial or legal advice.`;

/** Short version for embedding in tool responses */
export const MAINNET_WARNING = IS_MAINNET
  ? "Ethereum Mainnet: these are real US properties. Acquiring a token has legal and financial consequences set out in the trust instrument attached to it."
  : null;
