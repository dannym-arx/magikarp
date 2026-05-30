import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';

import { useAppContext } from '@/hooks/useAppContext';
import { fetchBtcPrice, satsToUSD } from '@/lib/bitcoin';
import { formatNumber } from '@/lib/formatNumber';
import {
  getShitcoinZapInfo,
  getZapAmountSats,
} from '@/lib/zapHelpers';
import type { CurrencyDisplay } from '@/contexts/AppContext';

interface FormatMoneyOptions {
  /**
   * Layout for the formatted string.
   * - "long" (default): `"6,300 sats"` / `"$2.50"`. Used in card headers and detail rows.
   * - "compact": `"6.3k"` / `"$2.50"`. Used in tight action bars where the unit/icon
   *   is supplied alongside; the function omits the trailing "sats" so the bolt
   *   icon next to it carries the unit. USD always includes the `$`.
   */
  layout?: 'long' | 'compact';
}

export interface FormatMoneyResult {
  /** Format a satoshi amount according to the user's currency preference. */
  format: (sats: number, options?: FormatMoneyOptions) => string;
  /**
   * Format the amount associated with a zap event. Routes shitcoin
   * kind-8333 events (DOGE/LTC/BCH/BSV/ETH/ZEC/ATOM) through chain-correct
   * USD math; falls back to {@link format} for BTC kind 8333 and kind 9735
   * Lightning receipts.
   */
  formatZap: (event: NostrEvent, options?: FormatMoneyOptions) => string;
  /** The active currency preference. Useful for choosing surrounding copy. */
  currency: CurrencyDisplay;
  /** The fetched BTC/USD price, if available. Undefined while loading or on failure. */
  btcPrice: number | undefined;
}

/**
 * Format a satoshi amount as a string according to the user's currency preference.
 *
 * When `currencyDisplay === 'usd'` (the default) and a BTC price is available,
 * the amount is converted to USD. If the price hasn't loaded yet or the request
 * failed, the function falls back to the sats representation so we never block
 * the UI on a network round-trip.
 *
 * The BTC price is fetched via TanStack Query with a `['btc-price', esploraApis]`
 * key — the same key used by the wallet, zap dialogs, and on-chain zap flows — so
 * a single request is deduped across the whole app.
 *
 * For shitcoin kind 8333 zaps (events carrying a `chain` tag or an `i` tag
 * with a non-bitcoin slug), {@link FormatMoneyResult.formatZap} renders the
 * chain-native amount only — never a USD value. Per-chain / per-token
 * price feeds are too brittle to surface confidently; a wrong USD ("$20K"
 * for what's actually 0.005 ETH because we applied the wrong divisor) is
 * worse than no USD. The user sees "25 DOGE" or "10 USDT" instead.
 */
export function useFormatMoney(): FormatMoneyResult {
  const { config } = useAppContext();
  const currency: CurrencyDisplay = config.currencyDisplay ?? 'usd';

  // Reuse the shared price query so all callers share one cached fetch.
  const { data: btcPrice } = useQuery({
    queryKey: ['btc-price', config.esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(config.esploraApis, signal),
    // Prices move; 60 s is fine for display formatting.
    staleTime: 60_000,
    // Don't pop a UI error if the price endpoint is down; we just fall back to sats.
    retry: 1,
    enabled: currency === 'usd',
  });

  const format = useCallback(
    (sats: number, options?: FormatMoneyOptions): string => {
      const layout = options?.layout ?? 'long';

      // USD mode with a known price → render dollars. We never round to zero
      // for a non-zero zap; show the cent value so the user sees that any zap
      // happened.
      if (currency === 'usd' && btcPrice && Number.isFinite(btcPrice) && btcPrice > 0) {
        return satsToUSD(sats, btcPrice);
      }

      // Sats mode, or USD mode without a price → render sats.
      if (layout === 'compact') {
        return formatNumber(sats);
      }
      return `${formatNumber(sats)} ${sats === 1 ? 'sat' : 'sats'}`;
    },
    [currency, btcPrice],
  );

  const formatZap = useCallback(
    (event: NostrEvent, options?: FormatMoneyOptions): string => {
      const shitcoin = getShitcoinZapInfo(event);
      if (!shitcoin) {
        // Regular BTC zap (kind 9735, or kind 8333 with bitcoin:tx:) — fall
        // back to the standard sats / USD path.
        return format(getZapAmountSats(event), options);
      }

      // **No USD math for shitcoin zaps.** Per-chain and per-token prices
      // are too brittle to surface confidently (we'd need an authoritative
      // multi-asset feed; the current Coingecko free tier mixes chain
      // prices with token prices that don't match what the `amount` tag
      // actually represents). Always render chain-native units: "25 DOGE",
      // "10 USDT", "0.005 ETH". A wrong USD is worse than no USD.
      const layout = options?.layout ?? 'long';
      const maxFractionDigits = shitcoin.chain === 'ETH' ? 6 : 4;
      const amountStr = shitcoin.amount.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxFractionDigits,
      });
      if (layout === 'compact') return amountStr;
      return `${amountStr} ${shitcoin.ticker}`;
    },
    [format],
  );

  return { format, formatZap, currency, btcPrice };
}
