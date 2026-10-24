import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});

import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { walletIfMe, walletOrOwn } from "../tools/own-wallet.js";
import type { AccountAuth } from "../auth/token.js";

const LINKED = "0x2222222222222222222222222222222222222222";
const EMBEDDED = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";

function auth(scopes: string[] = ["portfolio:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

const echo = vi.fn(async (address: string | undefined) => ({ read: address ?? null }));

function run(scopes: AccountAuth, args: { address?: string }, omittedMeansOwn: boolean, tool: (address: string) => Promise<object> = echo) {
  return omittedMeansOwn ? walletOrOwn(scopes, args.address, tool) : walletIfMe(scopes, args.address, echo);
}

beforeEach(() => {
  echo.mockClear();
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: LINKED, kind: "external" }, { address: EMBEDDED, kind: "embedded" }] });
});

describe("own wallet on the signed-in endpoint", () => {
  it("reads the wallet Fabrica created when the address is left out, and names the others", async () => {
    const result = await run(auth(), {}, true, echo);
    expect(echo).toHaveBeenCalledWith(EMBEDDED);
    expect(result).toMatchObject({ read: EMBEDDED, walletUsed: { address: EMBEDDED, kind: "embedded", otherWallets: [LINKED] } });
    expect(vi.mocked(getAccountProfile)).toHaveBeenCalledWith(expect.anything(), "portfolio:read");
  });

  it("takes \"me\" in any case where leaving the argument out means something else", async () => {
    expect(await run(auth(), { address: " Me " }, false, echo)).toMatchObject({ read: EMBEDDED });
    expect(await run(auth(), {}, false, echo)).toEqual({ read: null });
  });

  it("passes any other address through without reading the account", async () => {
    expect(await run(auth(), { address: OTHER }, true, echo)).toEqual({ read: OTHER });
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });

  it("needs portfolio:read for the person's own wallet", async () => {
    const result = await run(auth(["profile:read"]), {}, true, echo);
    expect(result).toMatchObject({ error: expect.stringContaining("portfolio:read") });
    expect(echo).not.toHaveBeenCalled();
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });

  it("asks for an address while the API does not serve the account, or when it has no wallet", async () => {
    vi.mocked(getAccountProfile).mockResolvedValueOnce(null);
    expect(await run(auth(), {}, true, echo)).toMatchObject({ error: expect.stringContaining("does not serve account details yet") });
    vi.mocked(getAccountProfile).mockResolvedValueOnce({ email: null, kycStatus: null, wallets: [] });
    expect(await run(auth(), {}, true, echo)).toMatchObject({ error: expect.stringContaining("No linked account") });
    expect(echo).not.toHaveBeenCalled();
  });

  it("passes a revoked connection through as the error", async () => {
    vi.mocked(getAccountProfile).mockRejectedValue(new AccountApiError(401, "Fabrica no longer accepts this connection"));
    expect(await run(auth(), {}, true, echo)).toEqual({ error: "Fabrica no longer accepts this connection" });
  });

  it("adds no walletUsed to a tool's own error", async () => {
    const failing = async () => ({ error: "Failed to get portfolio" });
    expect(await run(auth(), {}, true, failing)).toEqual({ error: "Failed to get portfolio" });
  });
});
