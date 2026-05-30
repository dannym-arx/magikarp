import type { NostrEvent } from '@nostrify/nostrify';
import { extractZapAmount } from '@/hooks/useEventInteractions';
import { SHITCOIN_META, type ShitcoinId } from '@/lib/shitcoins';
import { findErc20Token } from '@/lib/erc20Tokens';

/**
 * Atomic-units-per-coin for each chain. DOGE/LTC/BCH/BSV/ZEC use 8 decimals
 * (sats-equivalent), ETH uses 18 (wei), ATOM uses 6 (uatom).
 *
 * Kept in this module rather than imported from `shitcoinBalances` so the
 * zap-helpers stay independent of the balance-fetcher code path.
 */
const SHITCOIN_DECIMALS: Record<ShitcoinId, number> = {
  DOGE: 8,
  LTC: 8,
  BCH: 8,
  BSV: 8,
  ZEC: 8,
  ETH: 18,
  ATOM: 6,
};

/**
 * Information about a kind-8333 zap that targets a non-Bitcoin chain
 * (DOGE/LTC/BCH/BSV/ETH/ZEC/ATOM). Returned by {@link getShitcoinZapInfo}.
 */
export interface ShitcoinZapInfo {
  chain: ShitcoinId;
  ticker: string;
  /** Amount in whole-coin units (e.g. `25` for "25 DOGE", `1.5` for "1.5 USDT"). */
  amount: number;
  /** Atomic units exactly as stored in the event's `amount` tag. */
  atomic: number;
  /**
   * ERC-20 token symbol when the kind-8333 event represents an ETH-chain
   * token transfer (USDT/USDC/DAI/SHIB/PEPE/etc.). When set, `ticker`,
   * decimals, and renderer hints come from the token registry rather than
   * the chain. Always `undefined` for native chain transfers (DOGE, native
   * ETH, etc.).
   */
  token?: string;
  /** Display emoji — token emoji takes priority over chain emoji. */
  emoji: string;
}

/**
 * Detect a shitcoin kind-8333 zap and return its chain + amount in
 * whole-coin units. Returns `null` for BTC zaps (the normal case), for any
 * other kind, or when the event is malformed.
 *
 * Detection order:
 *   1. The Magikarp-specific `chain` tag (e.g. `["chain","DOGE"]`).
 *   2. The standard `i` tag's chain prefix (e.g. `dogecoin:tx:<txid>`).
 *      This lets us correctly classify events authored by other clients
 *      that follow the same convention.
 *
 * The amount tag is read as atomic units and divided by the chain's
 * decimal exponent. JS doubles are safe for any plausible shitcoin
 * balance.
 */
export function getShitcoinZapInfo(event: NostrEvent): ShitcoinZapInfo | null {
  if (event.kind !== 8333) return null;

  let chain: ShitcoinId | null = null;

  // Fast path: explicit `chain` tag.
  const chainTag = event.tags.find(([n]) => n === 'chain')?.[1];
  if (chainTag && Object.prototype.hasOwnProperty.call(SHITCOIN_META, chainTag)) {
    chain = chainTag as ShitcoinId;
  }

  // Fallback: parse the chain slug from the `i` tag prefix.
  if (!chain) {
    const iTag = event.tags.find(([n]) => n === 'i')?.[1];
    if (iTag) {
      const slug = iTag.split(':')[0];
      for (const [id, meta] of Object.entries(SHITCOIN_META)) {
        if (meta.coingeckoId === slug) {
          chain = id as ShitcoinId;
          break;
        }
      }
    }
  }

  if (!chain) return null;

  const amountTag = event.tags.find(([n]) => n === 'amount')?.[1];
  if (!amountTag) return null;
  const atomic = Number(amountTag);
  if (!Number.isFinite(atomic)) return null;

  // ERC-20 token override: if a `token` tag names a known token on the ETH
  // chain, use its decimals + ticker + emoji instead of the chain's. This
  // makes a "1 USDT" zap render as "1 USDT" (with USDT's 6-decimal divisor)
  // rather than as 0.000000000000000001 ETH.
  const tokenTag = event.tags.find(([n]) => n === 'token')?.[1];
  if (chain === 'ETH' && tokenTag) {
    const token = findErc20Token(tokenTag);
    if (token) {
      return {
        chain,
        ticker: token.symbol,
        amount: atomic / 10 ** token.decimals,
        atomic,
        token: token.symbol,
        emoji: token.emoji,
      };
    }
  }

  return {
    chain,
    ticker: SHITCOIN_META[chain].ticker,
    amount: atomic / 10 ** SHITCOIN_DECIMALS[chain],
    atomic,
    emoji: SHITCOIN_META[chain].emoji,
  };
}

/**
 * Extracts the zap amount in sats from either a kind 9735 Lightning zap
 * receipt or a kind 8333 on-chain Bitcoin zap event.
 *
 * Kind 9735 (NIP-57): the amount may live in (in order) the receipt's
 * `amount` tag (millisats), the embedded zap-request JSON's `amount` tag
 * (millisats), or — as a last resort — encoded inside the `bolt11`
 * invoice itself. Some LNURL providers omit the `amount` tag entirely
 * and rely solely on bolt11, which is why callers that don't fall back
 * to bolt11 will display "X zapped you" with no amount.
 *
 * Kind 8333: the `amount` tag carries sats directly (see NIP.md). For
 * multi-recipient batch zaps this is the **total** across all recipients
 * — callers that want the share paid to a single recipient should use
 * {@link getZapAmountSatsForRecipient}.
 *
 * Returns 0 when no amount can be determined.
 */
export function getZapAmountSats(event: NostrEvent): number {
  if (event.kind === 8333) {
    const amountTag = event.tags.find(([name]) => name === 'amount');
    if (amountTag?.[1]) {
      const sats = parseInt(amountTag[1], 10);
      if (!isNaN(sats) && sats > 0) return sats;
    }
    return 0;
  }

  // Kind 9735: extractZapAmount returns millisats and already falls back
  // through amount tag → description.tags amount → bolt11 invoice.
  const msats = extractZapAmount(event);
  return Math.floor(msats / 1000);
}

/**
 * Returns the zap amount in sats *attributable to a single recipient*.
 *
 * For kind 9735 Lightning receipts and single-recipient kind 8333 events
 * this is identical to {@link getZapAmountSats}.
 *
 * For multi-recipient kind 8333 batch zaps (NIP-BC: one tx, many `p`
 * tags, total in the `amount` tag), the per-recipient amount is not
 * encoded in the event — the spec says verifiers should recompute it by
 * matching each recipient's derived Taproot address against the on-chain
 * tx outputs. That's an async, esplora-dependent lookup, which is too
 * expensive for a notification card that renders synchronously.
 *
 * As a pragmatic approximation we evenly split the total across the
 * listed recipients. Magikarp's own zap-many flow always pays an equal
 * amount per recipient so this is exact for batches we produced; for
 * batches from other clients it's a reasonable estimate that will
 * never be more wrong than the recipient count.
 *
 * Without this split, a $250 zap-all sent to 500 people would render
 * to each recipient as "X zapped you $250", which is what users have
 * actually complained about.
 *
 * Returns 0 when no amount can be determined.
 */
export function getZapAmountSatsForRecipient(event: NostrEvent): number {
  const total = getZapAmountSats(event);
  if (event.kind !== 8333 || total === 0) return total;

  const recipientCount = countZapRecipients(event);
  if (recipientCount <= 1) return total;

  return Math.floor(total / recipientCount);
}

/**
 * Counts unique recipient `p` tags on a zap event. Used to detect
 * multi-recipient kind 8333 batch zaps and to evenly split the total
 * amount in {@link getZapAmountSatsForRecipient}.
 */
export function countZapRecipients(event: NostrEvent): number {
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] === 'p' && tag[1]) seen.add(tag[1]);
  }
  return seen.size;
}

/**
 * Extracts the sender pubkey from a zap event.
 *
 * Kind 9735: the receipt is signed by the LNURL provider, so the sender
 * lives in the uppercase `P` tag (preferred) or in the `description`
 * JSON's `pubkey` (the original zap request). Falls back to the event's
 * own pubkey, which is the LNURL provider — not great, but better than
 * an empty string.
 *
 * Kind 8333: the sender authors the event themselves, so `event.pubkey`
 * IS the sender (see NIP.md).
 */
export function getZapSenderPubkey(event: NostrEvent): string {
  if (event.kind === 8333) return event.pubkey;

  const pTag = event.tags.find(([name]) => name === 'P');
  if (pTag?.[1]) return pTag[1];
  const descTag = event.tags.find(([name]) => name === 'description');
  if (descTag?.[1]) {
    try {
      const zapRequest = JSON.parse(descTag[1]);
      if (zapRequest.pubkey) return zapRequest.pubkey;
    } catch { /* ignore */ }
  }
  return event.pubkey;
}

/**
 * Returns the ID of the target event being zapped/reacted-to/reposted, if
 * any. Reads the first `e` tag, which by convention points at the target.
 */
export function getTargetEventId(event: NostrEvent): string | undefined {
  return event.tags.find(([name]) => name === 'e')?.[1];
}
