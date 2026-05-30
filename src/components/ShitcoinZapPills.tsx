import { useMemo } from 'react';

import type { ShitcoinId } from '@/lib/shitcoins';
import { formatShitcoinAmount } from '@/lib/shitcoinBalances';
import type { ShitcoinZapBreakdown } from '@/hooks/useShitcoinZapsForEvent';

/**
 * Font stack used across the shitcoin UI. Matches the wallet, profile, and
 * zap-dialog surfaces so the meme aesthetic is consistent.
 */
const DOGE_FONT = '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive, sans-serif';

/**
 * Tiled 💩 background as an inline SVG data URI. Two glyphs at staggered
 * positions inside a 80×80 tile so the repeat doesn't look gridded.
 * Rendered at low opacity behind the content — decorative, never competing
 * with the pill text for readability.
 */
const POOP_TILE_BG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><text x='8' y='32' font-size='28'>%F0%9F%92%A9</text><text x='44' y='68' font-size='28'>%F0%9F%92%A9</text></svg>\")";

/**
 * Per-post shitcoin zap section. Big "Shitcoins" header, tiled poop-emoji
 * background, and a row of per-chain pills (each prefixed with its chain
 * emoji — 🐕 DOGE, 🥈 LTC, 🦄 ETH, etc.).
 *
 * Renders nothing when there are no shitcoin zaps on the target. DOGE pills
 * get the gold treatment because DOGE is, definitionally, the number-one
 * shitcoin.
 */
export function ShitcoinZapPills({ breakdown }: { breakdown: ShitcoinZapBreakdown }) {
  // Aggregate per-asset (chain OR token), not per-chain. The previous
  // per-chain aggregation collapsed "10 USDT + 0.005 ETH" into "10.005 ETH"
  // because both events have chain=ETH; reading from `entries[]` lets us
  // split per-asset using each entry's already-correct ticker/emoji.
  const perAsset = useMemo(() => {
    const map = new Map<string, { chain: ShitcoinId; ticker: string; emoji: string; amount: number }>();
    for (const entry of breakdown.entries) {
      // Asset key: token symbol if present (USDT/USDC/etc.), else chain
      // (DOGE/LTC/native-ETH/etc.). Tokens get distinct buckets from native
      // ETH on the same chain.
      const key = `${entry.chain}:${entry.ticker}`;
      const existing = map.get(key);
      if (existing) {
        existing.amount += entry.amount;
      } else {
        map.set(key, {
          chain: entry.chain,
          ticker: entry.ticker,
          emoji: entry.emoji,
          amount: entry.amount,
        });
      }
    }
    return Array.from(map.values());
  }, [breakdown.entries]);

  if (perAsset.length === 0) return null;
  return (
    <div className="relative mt-2 overflow-hidden rounded-xl border-2 border-amber-400/50 bg-amber-50 dark:bg-amber-950/30">
      {/* Tiled poop pattern — purely decorative, kept low-opacity so the
          pill text never competes with it for legibility. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.13] pointer-events-none"
        style={{
          backgroundImage: POOP_TILE_BG,
          backgroundRepeat: 'repeat',
          backgroundSize: '80px 80px',
        }}
      />
      {/* Content — wrapped in `relative` so it stacks above the bg overlay. */}
      <div className="relative px-3 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-2xl font-extrabold leading-none text-amber-700 dark:text-amber-300 drop-shadow-sm"
            style={{ fontFamily: DOGE_FONT }}
          >
            💩 Shitcoins 💩
          </span>
          <span
            className="text-[10px] uppercase tracking-wider text-amber-700/70 dark:text-amber-300/70"
            style={{ fontFamily: DOGE_FONT }}
          >
            {breakdown.count} zap{breakdown.count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {perAsset.map((asset) => {
            const isDoge = asset.ticker === 'DOGE';
            return (
              <span
                key={`${asset.chain}:${asset.ticker}`}
                className={
                  isDoge
                    ? 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold text-yellow-700 dark:text-yellow-300 bg-yellow-400/25 border border-yellow-400/60 shadow-sm'
                    : 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm text-amber-800 dark:text-amber-200 bg-white/70 dark:bg-amber-900/40 border border-amber-300/50'
                }
                style={{ fontFamily: DOGE_FONT }}
                title={`${formatShitcoinAmount(asset.amount, asset.chain)} ${asset.ticker} zapped`}
              >
                <span className="text-base leading-none" aria-hidden>{asset.emoji}</span>
                <span className="tabular-nums">{formatShitcoinAmount(asset.amount, asset.chain)}</span>
                <span className="text-xs uppercase tracking-wider">{asset.ticker}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
