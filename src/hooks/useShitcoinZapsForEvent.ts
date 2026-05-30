import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';

import { getShitcoinZapInfo } from '@/lib/zapHelpers';
import { SHITCOIN_META, type ShitcoinId } from '@/lib/shitcoins';
import { findErc20Token } from '@/lib/erc20Tokens';

/**
 * One per kind-8333 event that's been classified as a shitcoin zap.
 * Carries the underlying event so renderers can deep-link / fetch comments
 * if needed, plus pre-decoded display fields so each row doesn't re-parse.
 */
export interface ShitcoinZapEntry {
  /** The underlying kind-8333 event. */
  event: NostrEvent;
  chain: ShitcoinId;
  ticker: string;
  name: string;
  emoji: string;
  /** Amount in whole-coin units (e.g. `25` for "25 DOGE"). */
  amount: number;
  /** Atomic units (sats / wei / uatom — whatever the chain uses). */
  atomic: number;
  /** Sender pubkey — for kind 8333 this is just `event.pubkey`. */
  senderPubkey: string;
  /** On-chain tx hash (post-`<chain>:tx:` prefix). */
  txid: string;
  /** Unix seconds. */
  createdAt: number;
}

/**
 * Per-target breakdown of shitcoin zaps (kind 8333 events whose `chain` /
 * `i` tag identifies a non-Bitcoin chain). Used by the post action bar to
 * (a) correct the BTC-sats aggregate by subtracting shitcoin atomic amounts
 * wrongly summed by NIP-85 servers and (b) render a per-chain pills row.
 */
export interface ShitcoinZapBreakdown {
  /** Per-chain atomic-unit totals (sum of `amount` tag values). */
  perChainAtomic: Partial<Record<ShitcoinId, number>>;
  /** Per-chain whole-coin totals (atomic / 10^decimals). */
  perChainCoins: Partial<Record<ShitcoinId, number>>;
  /**
   * Sum of all shitcoin atomic amounts. Used to subtract from NIP-85
   * `zap_amount` aggregates that mistakenly treat every kind-8333 `amount`
   * tag as BTC sats — without this correction, a 25 DOGE zap (2,500,000,000
   * atomic units) inflates the BTC aggregate by 25 fictional BTC.
   */
  totalAtomic: number;
  /** Chains that have at least one zap on this target. Order = first-seen. */
  chains: ShitcoinId[];
  /** Number of distinct shitcoin zap events. */
  count: number;
  /**
   * Per-event entries (dedup'd by chain + i-tag), most-recent first. The
   * "Shit Zaps" tab in the post interactions modal renders these as rows.
   */
  entries: ShitcoinZapEntry[];
  isLoading: boolean;
}

const EMPTY_BREAKDOWN: ShitcoinZapBreakdown = {
  perChainAtomic: {},
  perChainCoins: {},
  totalAtomic: 0,
  chains: [],
  count: 0,
  entries: [],
  isLoading: false,
};

/**
 * Query and aggregate shitcoin kind-8333 zaps for a single target event.
 *
 * Queries the same `{kinds:[8333], '#e':[id]}` / `'#a':[coord]` filter set
 * `useOnchainZaps` uses, but classifies each event by chain via
 * `getShitcoinZapInfo` and ignores BTC events (they're handled by the
 * existing on-chain BTC zap pipeline).
 *
 * 30s stale time matches `useOnchainZaps` so both queries can dedupe.
 */
export function useShitcoinZapsForEvent(
  target: NostrEvent | undefined,
): ShitcoinZapBreakdown {
  const { nostr } = useNostr();
  const isAddressable = !!target && target.kind >= 30000 && target.kind < 40000;
  const dTag = isAddressable && target
    ? target.tags.find(([n]) => n === 'd')?.[1] ?? ''
    : '';
  const aCoord = isAddressable && target
    ? `${target.kind}:${target.pubkey}:${dTag}`
    : '';

  const eventsQuery = useQuery({
    queryKey: ['shitcoin-zaps', 'events', target?.id ?? '', aCoord],
    queryFn: async ({ signal }) => {
      if (!target) return [] as NostrEvent[];
      const timeout = AbortSignal.timeout(5000);
      const combined = AbortSignal.any([signal, timeout]);
      const filters: Parameters<typeof nostr.query>[0] = [
        { kinds: [8333], '#e': [target.id], limit: 100 },
      ];
      if (aCoord) {
        filters.push({ kinds: [8333], '#a': [aCoord], limit: 100 });
      }
      return await nostr.query(filters, { signal: combined });
    },
    enabled: !!target,
    staleTime: 30_000,
  });

  return useMemo(() => {
    if (!eventsQuery.data) {
      return { ...EMPTY_BREAKDOWN, isLoading: eventsQuery.isLoading };
    }
    const perChainAtomic: Partial<Record<ShitcoinId, number>> = {};
    const perChainCoins: Partial<Record<ShitcoinId, number>> = {};
    const entries: ShitcoinZapEntry[] = [];
    let totalAtomic = 0;
    let count = 0;
    const order: ShitcoinId[] = [];
    const seen = new Set<ShitcoinId>();

    // Dedupe by event id first — relays may echo the same event from
    // multiple URLs. Then by txid — same chain tx published twice as
    // separate Nostr events should only count once.
    const byId = new Map<string, NostrEvent>();
    for (const e of eventsQuery.data) byId.set(e.id, e);

    const byTxid = new Set<string>();
    for (const event of byId.values()) {
      const info = getShitcoinZapInfo(event);
      if (!info) continue;
      const iTag = event.tags.find(([n]) => n === 'i')?.[1] ?? '';
      const dedupKey = `${info.chain}:${iTag}`;
      if (byTxid.has(dedupKey)) continue;
      byTxid.add(dedupKey);

      perChainAtomic[info.chain] = (perChainAtomic[info.chain] ?? 0) + info.atomic;
      perChainCoins[info.chain] = (perChainCoins[info.chain] ?? 0) + info.amount;
      totalAtomic += info.atomic;
      count += 1;
      if (!seen.has(info.chain)) {
        seen.add(info.chain);
        order.push(info.chain);
      }

      const txid = iTag.split(':').slice(2).join(':');
      // For ERC-20 token zaps the "name" displayed under the ticker should
      // be the token name (e.g. "Tether"), not the chain name (Ethereum).
      const token = info.token ? findErc20Token(info.token) : undefined;
      const displayName = token?.name ?? SHITCOIN_META[info.chain].name;
      entries.push({
        event,
        chain: info.chain,
        ticker: info.ticker,
        name: displayName,
        emoji: info.emoji,
        amount: info.amount,
        atomic: info.atomic,
        senderPubkey: event.pubkey,
        txid,
        createdAt: event.created_at,
      });
    }
    // Most-recent first for the modal row list.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return {
      perChainAtomic,
      perChainCoins,
      totalAtomic,
      chains: order,
      count,
      entries,
      isLoading: eventsQuery.isLoading,
    };
  }, [eventsQuery.data, eventsQuery.isLoading]);
}
