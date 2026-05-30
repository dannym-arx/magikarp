/**
 * Cross-chain balance + USD price fetchers for the seven shitcoins Magikarp
 * derives addresses for.
 *
 * Per-chain providers with inline failover (Blockchair was blanket-banning the
 * project IP, so we now route each chain to a dedicated public API and only
 * fall back to Blockchair for chains where no clean free alternative exists):
 *
 *   DOGE  → blockcypher.com (primary) → dogechain.info (fallback)
 *   LTC   → litecoinspace.org Esplora (primary) → blockcypher.com (fallback)
 *   BSV   → whatsonchain.com (primary)
 *   ETH   → cloudflare-eth.com JSON-RPC (primary) → rpc.ankr.com/eth (fallback)
 *   ATOM  → rest.cosmos.directory (primary) → lcd-cosmoshub.keplr.app (fallback)
 *   BCH   → blockchair (acknowledged: may 0-fallback on IP ban)
 *   ZEC   → blockchair (acknowledged: may 0-fallback on IP ban)
 *
 * All endpoints are free, CORS-enabled, and require no API key. USD prices
 * come from coingecko in a single multi-id request.
 *
 * Balances are returned in **whole-coin** units (number, not BigInt) — the UI
 * never needs more precision than display, and JS double is safe to ~15 sig
 * figures for every chain at any plausible balance.
 */
import { type ShitcoinId } from './shitcoins';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/**
 * Coingecko's ID for each chain. BSV's ID is `bitcoin-cash-sv` (legacy from
 * the fork days); if Coingecko ever delists it the price will silently fall
 * back to `undefined` and the UI degrades gracefully.
 */
const COINGECKO_ID: Record<ShitcoinId, string> = {
  DOGE: 'dogecoin',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  BSV: 'bitcoin-cash-sv',
  ETH: 'ethereum',
  ZEC: 'zcash',
  ATOM: 'cosmos',
};

/**
 * Decimals per chain's atomic unit:
 *   - BTC-like (DOGE/LTC/BCH/BSV/ZEC): 1e8 satoshi-equivalents per coin
 *   - ETH: 1e18 wei per ETH
 *   - ATOM: 1e6 uatom per ATOM
 */
const DECIMALS: Record<ShitcoinId, number> = {
  DOGE: 8,
  LTC: 8,
  BCH: 8,
  BSV: 8,
  ZEC: 8,
  ETH: 18,
  ATOM: 6,
};

/** A balance + (optional) USD value for a single chain. */
export interface ShitcoinBalance {
  /** The chain id this balance is for. */
  id: ShitcoinId;
  /** Balance in whole-coin units (e.g. 1.23 DOGE, 0.001 ETH). */
  amount: number;
  /** USD value if a price was available, else `undefined`. */
  usd: number | undefined;
}

/** Map of chain → USD price (one entry per chain that Coingecko knew about). */
export type ShitcoinPrices = Partial<Record<ShitcoinId, number>>;

// ---------------------------------------------------------------------------
// Per-chain balance fetchers (inline failover)
// ---------------------------------------------------------------------------

/**
 * Try each fetcher in order. Returns the first non-`null` result. If all
 * fetchers throw or return `null`, returns `0` — the joke fork doesn't
 * benefit from showing error states, an empty wallet is funny by itself.
 */
async function withFailover(
  attempts: Array<() => Promise<number | null>>,
): Promise<number> {
  for (const attempt of attempts) {
    try {
      const v = await attempt();
      if (v !== null) return v;
    } catch {
      // try next provider
    }
  }
  return 0;
}

async function fetchDogeBalance(addr: string, signal?: AbortSignal): Promise<number> {
  return withFailover([
    // blockcypher.com: 200 req/hr free, well-known CORS. Returns sats integers.
    async () => {
      const url = `https://api.blockcypher.com/v1/doge/main/addrs/${addr}/balance`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { balance?: number };
      if (typeof json.balance !== 'number') return null;
      return json.balance / 10 ** DECIMALS.DOGE;
    },
    // dogechain.info: returns balance as a string in whole DOGE.
    async () => {
      const url = `https://dogechain.info/api/v1/address/balance/${addr}`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { success?: number; balance?: string };
      if (json.success !== 1 || typeof json.balance !== 'string') return null;
      const n = Number(json.balance);
      return Number.isFinite(n) ? n : null;
    },
  ]);
}

async function fetchLtcBalance(addr: string, signal?: AbortSignal): Promise<number> {
  return withFailover([
    // litecoinspace.org: Esplora-compatible, no rate limit. Same shape as
    // mempool.space: balance = funded_txo_sum - spent_txo_sum (sats).
    async () => {
      const url = `https://litecoinspace.org/api/address/${addr}`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
      };
      const funded = json.chain_stats?.funded_txo_sum;
      const spent = json.chain_stats?.spent_txo_sum;
      if (typeof funded !== 'number' || typeof spent !== 'number') return null;
      return (funded - spent) / 10 ** DECIMALS.LTC;
    },
    // blockcypher fallback.
    async () => {
      const url = `https://api.blockcypher.com/v1/ltc/main/addrs/${addr}/balance`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { balance?: number };
      if (typeof json.balance !== 'number') return null;
      return json.balance / 10 ** DECIMALS.LTC;
    },
  ]);
}

async function fetchBsvBalance(addr: string, signal?: AbortSignal): Promise<number> {
  return withFailover([
    // whatsonchain.com — canonical BSV public API.
    async () => {
      const url = `https://api.whatsonchain.com/v1/bsv/main/address/${addr}/balance`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { confirmed?: number; unconfirmed?: number };
      const confirmed = json.confirmed ?? 0;
      const unconfirmed = json.unconfirmed ?? 0;
      return (confirmed + unconfirmed) / 10 ** DECIMALS.BSV;
    },
  ]);
}

async function fetchEthBalance(addr: string, signal?: AbortSignal): Promise<number> {
  const rpcCall = async (rpcUrl: string): Promise<number | null> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [addr.toLowerCase(), 'latest'],
        id: 1,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    if (typeof json.result !== 'string') return null;
    // result is hex wei (e.g. "0x1bc16d674ec80000"); convert via BigInt then
    // divide by 1e18 to whole ETH.
    const wei = BigInt(json.result);
    return Number(wei) / 10 ** DECIMALS.ETH;
  };

  // Ankr (paid-tier keyed) primary, cloudflare-eth keyless fallback. The
  // Ankr key is shared with the signing path in `shitcoinSigners.ts` — keep
  // them in sync.
  return withFailover([
    () => rpcCall('https://rpc.ankr.com/eth/2cb50a1e7fddfab168ddc4d2731b66f49e78df462cbbb1f8b43b22ce721e0d5a'),
    () => rpcCall('https://cloudflare-eth.com'),
  ]);
}

async function fetchAtomBalance(addr: string, signal?: AbortSignal): Promise<number> {
  const lcdCall = async (base: string): Promise<number | null> => {
    const url = `${base}/cosmos/bank/v1beta1/balances/${addr}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      balances?: Array<{ denom?: string; amount?: string }>;
    };
    const uatom = (json.balances ?? []).find((b) => b.denom === 'uatom')?.amount;
    if (!uatom) return 0;
    const atomic = Number(uatom);
    if (!Number.isFinite(atomic)) return null;
    return atomic / 10 ** DECIMALS.ATOM;
  };
  return withFailover([
    () => lcdCall('https://rest.cosmos.directory/cosmoshub'),
    () => lcdCall('https://lcd-cosmoshub.keplr.app'),
  ]);
}

interface BlockchairAddressResponse {
  data?: Record<string, { address?: { balance?: string | number } }>;
}

/**
 * Blockchair fallback for BCH + ZEC. Documented to potentially 0-fallback
 * when the project IP is rate-limited or blacklisted — the user accepted
 * this tradeoff because no clean free alternative exists for these two
 * chains. The dashboard endpoint shape matches the other chains it serves.
 */
async function fetchBlockchairBalance(
  chain: ShitcoinId,
  slug: string,
  address: string,
  signal?: AbortSignal,
): Promise<number> {
  const url = `https://api.blockchair.com/${slug}/dashboards/address/${address}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return 0;
    const json = (await res.json()) as BlockchairAddressResponse;
    const raw = json.data?.[address]?.address?.balance;
    if (raw === undefined || raw === null) return 0;
    const atomic = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(atomic)) return 0;
    return atomic / 10 ** DECIMALS[chain];
  } catch {
    return 0;
  }
}

async function fetchOneBalance(
  chain: ShitcoinId,
  address: string,
  signal?: AbortSignal,
): Promise<number> {
  switch (chain) {
    case 'DOGE': return fetchDogeBalance(address, signal);
    case 'LTC':  return fetchLtcBalance(address, signal);
    case 'BSV':  return fetchBsvBalance(address, signal);
    case 'ETH':  return fetchEthBalance(address, signal);
    case 'ATOM': return fetchAtomBalance(address, signal);
    case 'BCH':  return fetchBlockchairBalance('BCH', 'bitcoin-cash', address, signal);
    case 'ZEC':  return fetchBlockchairBalance('ZEC', 'zcash', address, signal);
  }
}

/**
 * Fetch balances for every wallet in `wallets` in parallel. Order of the
 * returned array matches `wallets`.
 */
export async function fetchShitcoinBalances(
  wallets: Array<{ id: ShitcoinId; address: string }>,
  signal?: AbortSignal,
): Promise<ShitcoinBalance[]> {
  return Promise.all(
    wallets.map(async (w): Promise<ShitcoinBalance> => {
      const amount = await fetchOneBalance(w.id, w.address, signal);
      return { id: w.id, amount, usd: undefined };
    }),
  );
}

/**
 * Fetch USD prices for all 7 chains in a single Coingecko request. Returns
 * a partial map — missing chains (delisted, throttled, malformed) are just
 * absent and the UI shows the coin balance without a USD line.
 */
export async function fetchShitcoinPrices(signal?: AbortSignal): Promise<ShitcoinPrices> {
  const ids = Object.values(COINGECKO_ID).join(',');
  const url = `${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return {};
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const out: ShitcoinPrices = {};
    for (const chainId of Object.keys(COINGECKO_ID) as ShitcoinId[]) {
      const usd = json[COINGECKO_ID[chainId]]?.usd;
      if (typeof usd === 'number' && Number.isFinite(usd)) {
        out[chainId] = usd;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Format a shitcoin balance for display. Picks reasonable decimal precision
 * per chain so DOGE doesn't end up as "1.00000000" and ETH doesn't get
 * truncated to nothing.
 */
export function formatShitcoinAmount(amount: number, chain: ShitcoinId): string {
  if (amount === 0) return '0';
  const maxFractionDigits = chain === 'ETH' ? 6 : 4;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}

/** Format a USD value (e.g. `$0.05`, `$1,234.56`). Returns `'—'` if unknown. */
export function formatShitcoinUsd(usd: number | undefined): string {
  if (usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
