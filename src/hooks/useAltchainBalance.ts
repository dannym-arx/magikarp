import { useQuery } from '@tanstack/react-query';

import type { ShitcoinId } from '@/lib/shitcoins';

/** Blockchair slug per chain id. ETH is handled separately via Alchemy. */
const BLOCKCHAIR_SLUG: Partial<Record<ShitcoinId, string>> = {
  DOGE: 'dogecoin',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  BSV: 'bitcoin-sv',
};

/** Smallest-unit divisor per chain (all UTXO chains use 1e8). */
const DIVISOR: Partial<Record<ShitcoinId, number>> = {
  DOGE: 1e8,
  LTC: 1e8,
  BCH: 1e8,
  BSV: 1e8,
};

/** What we hand back to the UI: balance string + raw native units. */
export interface AltchainBalance {
  /** Human-readable balance in the chain's native unit, e.g. "12.34567890". */
  formatted: string;
  /** Raw integer balance in the chain's smallest unit. */
  raw: bigint;
  /** Spot USD price, or undefined if unavailable. */
  usdPrice?: number;
}

interface BlockchairResponse {
  data: Record<
    string,
    {
      address: { balance: number };
    }
  >;
  context?: { market_price_usd?: number };
}

async function fetchBlockchairBalance(
  slug: string,
  address: string,
  signal?: AbortSignal,
): Promise<{ raw: bigint; usdPrice?: number }> {
  const url = `https://api.blockchair.com/${slug}/dashboards/address/${address}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Blockchair ${slug} ${res.status}`);
  const json = (await res.json()) as BlockchairResponse;
  const entry = json.data?.[address];
  // Blockchair returns a JS-number balance — fine for sub-2^53 sats, which
  // covers every realistic UTXO holding. Wrap as bigint for downstream sanity.
  const raw = BigInt(Math.max(0, Math.floor(entry?.address?.balance ?? 0)));
  return { raw, usdPrice: json.context?.market_price_usd };
}

/**
 * Fetch the on-chain balance for one of the derived DOGE/LTC/BCH/BSV
 * addresses via Blockchair's free public dashboards endpoint.
 *
 * Returns `undefined` (and never throws into the render path) for ETH —
 * ETH is handled by `useEthAssets`, which fetches native + every ERC-20.
 */
export function useAltchainBalance(chain: ShitcoinId, address: string): {
  data: AltchainBalance | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const slug = BLOCKCHAIR_SLUG[chain];
  const divisor = DIVISOR[chain];

  const { data, isLoading, error } = useQuery({
    queryKey: ['altchain-balance', chain, address],
    queryFn: async ({ signal }): Promise<AltchainBalance> => {
      const { raw, usdPrice } = await fetchBlockchairBalance(slug!, address, signal);
      const native = Number(raw) / divisor!;
      // Trim trailing zeros while keeping up to 8 decimals.
      const formatted = native
        .toFixed(8)
        .replace(/\.?0+$/, '')
        .replace(/^$/, '0');
      return { raw, formatted: formatted || '0', usdPrice };
    },
    enabled: !!slug && !!address,
    refetchInterval: 120_000,
    staleTime: 60_000,
    // Don't hammer on failure — public Blockchair is rate-limited.
    retry: 1,
  });

  return { data, isLoading, error };
}
