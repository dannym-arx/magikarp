import { useMemo } from 'react';
import { Rocket } from 'lucide-react';

import {
  nostrPubkeyToShitcoinAddresses,
  type ShitcoinWallet,
} from '@/lib/shitcoins';
import { useShitcoinBalances } from '@/hooks/useShitcoinBalances';
import { formatShitcoinAmount, formatShitcoinUsd } from '@/lib/shitcoinBalances';

/**
 * Font stack used across the shitcoin UI. Comic Neue first (loaded lazily
 * via the theme system), falling back to Comic Sans variants and a cursive
 * default so the meme aesthetic lands even before the webfont resolves.
 */
const DOGE_FONT = '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive, sans-serif';

interface ProfileShitcoinBalancesProps {
  /** The npub-as-hex whose shitcoin balances we'll surface. */
  pubkey: string;
}

/**
 * The privacy-leak made visible. Every Nostr profile gets a derived address
 * on DOGE / LTC / BCH / BSV / ETH / ZEC / ATOM (no consent, no opt-in — the
 * derivation is a pure function of the npub), so we can render any user's
 * cross-chain balance under their profile without ever asking them.
 *
 * This is the satirical core of the fork: "on-chain identity" treated as a
 * given means anyone's cross-chain net worth is public by construction.
 *
 * Layout: a 4-col grid (top row: DOGE / LTC / BCH / BSV, bottom: ETH / ZEC /
 * ATOM / TOTAL) — DOGE is highlighted because it's the number-one shitcoin.
 *
 * Performance: the underlying `useShitcoinBalances` hook caches per-wallet
 * with a 60s stale time, so two adjacent profile views of the same npub
 * dedup. Across many different profiles, the rate limits on blockcypher /
 * litecoinspace / whatsonchain / cosmos.directory / blockchair will fire
 * eventually — each fetcher silently falls back to 0 when rate-limited, so
 * the UI doesn't visibly break, it just shows zeros until cooldown.
 */
export function ProfileShitcoinBalances({ pubkey }: ProfileShitcoinBalancesProps) {
  const wallets = useMemo<ShitcoinWallet[]>(
    () => nostrPubkeyToShitcoinAddresses(pubkey),
    [pubkey],
  );
  const { joined } = useShitcoinBalances(wallets);

  if (wallets.length === 0) return null;

  const totalUsd = joined.reduce((sum, b) => sum + (b.usd ?? 0), 0);

  return (
    <div className="mt-4 rounded-xl border border-yellow-400/30 bg-gradient-to-b from-yellow-400/5 to-transparent p-3">
      {/* Header — leans into the privacy joke explicitly */}
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-1.5">
          <Rocket className="size-3.5 text-yellow-500" />
          <span
            className="text-xs uppercase tracking-[0.15em] text-yellow-700 dark:text-yellow-300"
            style={{ fontFamily: DOGE_FONT }}
          >
            Shitcoin Holdings
          </span>
        </div>
        <span
          className="text-[10px] text-muted-foreground"
          style={{ fontFamily: DOGE_FONT }}
        >
          (derived from npub. no consent required.)
        </span>
      </div>

      {/* 4×2 grid — three rows for 7 chains plus a "total" tile */}
      <div className="grid grid-cols-4 gap-1.5">
        {joined.map((b) => (
          <BalanceTile key={b.wallet.id} wallet={b.wallet} amount={b.amount} usd={b.usd} />
        ))}
        {/* Total tile */}
        <div className="rounded-md border-2 border-yellow-400/40 bg-yellow-400/10 px-2 py-2 text-center">
          <p
            className="text-[10px] uppercase tracking-wider text-yellow-700 dark:text-yellow-300"
            style={{ fontFamily: DOGE_FONT }}
          >
            net worth
          </p>
          <p
            className="text-sm font-bold tabular-nums text-yellow-700 dark:text-yellow-300"
            style={{ fontFamily: DOGE_FONT }}
          >
            {formatShitcoinUsd(totalUsd > 0 ? totalUsd : undefined)}
          </p>
          <p
            className="text-[9px] text-muted-foreground italic"
            style={{ fontFamily: DOGE_FONT }}
          >
            wen lambo
          </p>
        </div>
      </div>
    </div>
  );
}

function BalanceTile({
  wallet,
  amount,
  usd,
}: {
  wallet: ShitcoinWallet;
  amount: number;
  usd: number | undefined;
}) {
  const isDoge = wallet.id === 'DOGE';
  return (
    <div
      className={
        isDoge
          ? 'rounded-md border-2 border-yellow-400/60 bg-yellow-400/10 px-2 py-2 text-center'
          : 'rounded-md border px-2 py-2 text-center'
      }
    >
      <p
        className="text-[10px] uppercase tracking-wider text-muted-foreground"
        style={{ fontFamily: DOGE_FONT }}
      >
        <span className="mr-0.5" aria-hidden>{wallet.emoji}</span>
        {wallet.ticker}
      </p>
      <p
        className="text-xs font-medium tabular-nums truncate"
        style={{ fontFamily: DOGE_FONT }}
        title={`${formatShitcoinAmount(amount, wallet.id)} ${wallet.ticker}`}
      >
        {formatShitcoinAmount(amount, wallet.id)}
      </p>
      <p
        className="text-[10px] text-muted-foreground tabular-nums"
        style={{ fontFamily: DOGE_FONT }}
      >
        {formatShitcoinUsd(usd)}
      </p>
    </div>
  );
}
