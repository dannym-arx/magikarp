import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  fetchShitcoinBalances,
  fetchShitcoinPrices,
  type ShitcoinBalance,
  type ShitcoinPrices,
} from '@/lib/shitcoinBalances';
import { type ShitcoinWallet } from '@/lib/shitcoins';

/**
 * Fetch balances + USD prices for a derived shitcoin wallet set. Two
 * independent queries (balances vs prices) so a price-feed hiccup doesn't
 * blank the balances and vice versa.
 *
 * - Balances poll every 60s (cheaper than BTC's 30s, since blockchair has
 *   tighter rate limits and shitcoin balances on identity-derived addresses
 *   change... essentially never).
 * - Prices poll every 5 minutes (coingecko free tier has aggressive limits).
 *
 * Returns `joined` — the wallet list with `amount` + `usd` filled in. Order
 * is preserved from the input.
 */
export function useShitcoinBalances(wallets: ShitcoinWallet[]) {
  const cacheKey = useMemo(
    () => wallets.map((w) => `${w.id}:${w.address}`).join('|'),
    [wallets],
  );

  const balanceQuery = useQuery({
    queryKey: ['shitcoin-balances', cacheKey],
    queryFn: ({ signal }) =>
      fetchShitcoinBalances(
        wallets.map((w) => ({ id: w.id, address: w.address })),
        signal,
      ),
    enabled: wallets.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const priceQuery = useQuery({
    queryKey: ['shitcoin-prices'],
    queryFn: ({ signal }) => fetchShitcoinPrices(signal),
    enabled: wallets.length > 0,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const joined = useMemo(() => {
    const balances: ShitcoinBalance[] = balanceQuery.data ?? [];
    const prices: ShitcoinPrices = priceQuery.data ?? {};
    const byId = new Map(balances.map((b) => [b.id, b]));
    return wallets.map((w) => {
      const b = byId.get(w.id);
      const amount = b?.amount ?? 0;
      const price = prices[w.id];
      const usd = price !== undefined ? amount * price : undefined;
      return { wallet: w, amount, usd, price };
    });
  }, [wallets, balanceQuery.data, priceQuery.data]);

  return {
    joined,
    prices: priceQuery.data ?? {},
    isLoading: balanceQuery.isLoading || priceQuery.isLoading,
    refetch: () => Promise.all([balanceQuery.refetch(), priceQuery.refetch()]),
  };
}
