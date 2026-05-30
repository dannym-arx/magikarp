/**
 * Minimal Ethereum JSON-RPC client + ERC-20 enumeration helpers.
 *
 * Deliberately no viem/ethers dep: we make three fetch calls (one batched
 * RPC for ETH balance + token balances, one for token metadata, one for ETH
 * USD price) and format the results. Nothing here signs, sends, or holds
 * state — Magikarp's ETH support is display-only by design (see
 * `lib/shitcoins.ts` for the y-parity caveat that makes spending awkward).
 */

/** Single JSON-RPC request envelope. */
interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

/** Single JSON-RPC response envelope. */
interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

/** Raw shape returned by `alchemy_getTokenBalances`. */
interface AlchemyTokenBalances {
  address: string;
  tokenBalances: { contractAddress: string; tokenBalance: string | null }[];
}

/** Raw shape returned by `alchemy_getTokenMetadata`. */
interface AlchemyTokenMetadata {
  decimals: number | null;
  logo: string | null;
  name: string | null;
  symbol: string | null;
}

/** A single ERC-20 holding, ready to render. */
export interface Erc20Holding {
  /** Lowercase 0x… contract address. */
  contract: string;
  /** Raw integer balance (smallest unit). `null` means the call failed for this token. */
  rawBalance: bigint | null;
  /** Human-readable balance string, e.g. "1234.5678". */
  formattedBalance: string;
  /** Token symbol, or a short contract suffix if missing. */
  symbol: string;
  /** Token name, or "Unknown token" if missing. */
  name: string;
  /** Logo URL, if Alchemy has one. */
  logo: string | null;
  /** ERC-20 decimals, defaulting to 18 when unknown. */
  decimals: number;
}

/** Aggregate snapshot of an Ethereum address: native + every ERC-20. */
export interface EthAssetSnapshot {
  /** Native ETH balance in wei. */
  weiBalance: bigint;
  /** Native ETH balance formatted as ether ("1.2345"). */
  ethBalance: string;
  /** Every ERC-20 the address holds — including spam/airdrop tokens. */
  tokens: Erc20Holding[];
}

/** Pack one or more RPC calls into a batched POST. */
async function rpc<T>(
  endpoint: string,
  requests: Omit<RpcRequest, 'jsonrpc'>[],
  signal?: AbortSignal,
): Promise<T[]> {
  const body: RpcRequest[] = requests.map((r) => ({ jsonrpc: '2.0', ...r }));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);

  const json = (await res.json()) as RpcResponse<T>[];
  // Sort by id so callers can index by request order.
  const byId = new Map(json.map((r) => [r.id, r] as const));
  return body.map((req) => {
    const r = byId.get(req.id);
    if (!r) throw new Error(`RPC missing id ${req.id}`);
    if (r.error) throw new Error(`RPC ${req.method}: ${r.error.message}`);
    return r.result as T;
  });
}

/** Format a wei/raw-units bigint with the given decimals, trimming trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString();
  const negative = value < 0n;
  const v = negative ? -value : value;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  let frac = s.slice(-decimals).replace(/0+$/, '');
  // Cap to 6 fractional digits for display sanity.
  if (frac.length > 6) frac = frac.slice(0, 6);
  const out = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${out}` : out;
}

/**
 * Fetch ETH balance + every ERC-20 the address holds, plus per-token metadata.
 *
 * NB: `alchemy_getTokenBalances` returns up to 100 tokens by default — for the
 * meme-grade airdrop-victim address that holds more, this is fine: we're
 * showing "every shitcoin we can see", not promising a complete index.
 */
export async function fetchEthAssets(
  address: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<EthAssetSnapshot> {
  const addr = address.toLowerCase();

  const [weiHex, balances] = await rpc<string | AlchemyTokenBalances>(
    endpoint,
    [
      { id: 1, method: 'eth_getBalance', params: [addr, 'latest'] },
      { id: 2, method: 'alchemy_getTokenBalances', params: [addr, 'erc20'] },
    ],
    signal,
  ) as [string, AlchemyTokenBalances];

  const weiBalance = BigInt(weiHex);
  const ethBalance = formatUnits(weiBalance, 18);

  // Filter to non-zero balances before fetching metadata so the spam list
  // doesn't include every contract that ever brushed against this address.
  const nonZero = balances.tokenBalances.filter(
    (t) => t.tokenBalance && BigInt(t.tokenBalance) > 0n,
  );

  if (nonZero.length === 0) {
    return { weiBalance, ethBalance, tokens: [] };
  }

  // Batched metadata lookup — one RPC per token, but in a single HTTP request.
  const metadataResults = await rpc<AlchemyTokenMetadata>(
    endpoint,
    nonZero.map((t, i) => ({
      id: i + 1,
      method: 'alchemy_getTokenMetadata',
      params: [t.contractAddress],
    })),
    signal,
  );

  const tokens: Erc20Holding[] = nonZero.map((t, i) => {
    const meta = metadataResults[i] ?? {};
    const decimals = typeof meta.decimals === 'number' ? meta.decimals : 18;
    const raw = t.tokenBalance ? BigInt(t.tokenBalance) : null;
    return {
      contract: t.contractAddress.toLowerCase(),
      rawBalance: raw,
      formattedBalance: raw === null ? '?' : formatUnits(raw, decimals),
      symbol: meta.symbol ?? t.contractAddress.slice(2, 8).toUpperCase(),
      name: meta.name ?? 'Unknown token',
      logo: meta.logo,
      decimals,
    };
  });

  return { weiBalance, ethBalance, tokens };
}

/**
 * Fetch ETH/USD spot price from CoinGecko. CoinGecko's free endpoint is
 * key-less and CORS-friendly, which is all we need for a display badge.
 */
export async function fetchEthPrice(signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { ethereum?: { usd?: number } };
    return json.ethereum?.usd ?? null;
  } catch {
    return null;
  }
}
