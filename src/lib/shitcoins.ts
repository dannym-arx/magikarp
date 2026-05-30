/**
 * Shitcoin address derivation — DOGE, LTC, BCH, BSV, ETH, ZEC, ATOM from a
 * Nostr key.
 *
 * Every npub is also: a DOGE wallet, an LTC wallet, a BCH wallet, a BSV
 * wallet, an ETH wallet, a ZEC wallet (transparent), and a Cosmos ATOM
 * wallet. This proves that "on-chain zaps" don't depend on the chain — they
 * depend on collapsing your identity key into your money key, which every
 * secp256k1 chain enables for free.
 *
 * Adapted from a standalone `derive.ts` demo into a browser module that
 * reuses Magikarp's existing crypto stack:
 *   - `@noble/curves/secp256k1` for EC point math (same `Point` class as
 *     `silentPayments.ts`),
 *   - `@noble/hashes` for sha256 / ripemd160 / keccak256,
 *   - `@scure/base` for base58check + bech32 + hex.
 *
 * ## Y-parity convention
 *
 * Nostr public keys are x-only (BIP-340): the y-coordinate's parity bit is
 * discarded. To derive a deterministic address from just the 32-byte x-only
 * pubkey, we force-assume **even-y** (compressed prefix `0x02`). This matches
 * the convention used by the original `derive.ts` so that nsec-input and
 * npub-input produce identical addresses.
 *
 * Spending from these addresses with the original nsec requires negating the
 * private key when the real y-parity was odd: `signingKey = (n - d) mod n`.
 * (Spending is out of scope here — Magikarp only *derives and displays* these
 * addresses, since the chains have no Nostr-native send flow.)
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { base58check as base58checkFactory, bech32, hex } from '@scure/base';
import { nip19 } from 'nostr-tools';

/**
 * secp256k1 projective-point constructor. `@noble/curves` v1 exposes it as
 * `secp256k1.ProjectivePoint` — same export `silentPayments.ts` relies on.
 */
const Point = secp256k1.ProjectivePoint;

/** base58check codec wired to double-sha256-style checksum (single-sha here). */
const base58check = base58checkFactory(sha256);

/** RIPEMD160(SHA256(data)) — the standard Bitcoin "hash160". */
const hash160 = (data: Uint8Array) => ripemd160(sha256(data));

/** Strict 32-byte x-only pubkey validator (64 hex chars). */
function isValidXOnlyHex(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/** Lowercase a hex string before handing it to `@scure/base` (lowercase-only). */
function hexDecode(s: string): Uint8Array {
  return hex.decode(s.toLowerCase());
}

/**
 * Take a 32-byte x-only pubkey, force even-y, and return both the compressed
 * (33-byte) and uncompressed (65-byte) SEC encodings.
 *
 * Throws if the x-coordinate is not a valid point on the curve.
 */
function pubkeysFromXOnly(xOnly: Uint8Array): {
  compressed: Uint8Array;
  uncompressed: Uint8Array;
} {
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02; // forced even-y
  compressed.set(xOnly, 1);
  const point = Point.fromHex(compressed);
  return {
    compressed: point.toRawBytes(true),
    uncompressed: point.toRawBytes(false),
  };
}

/** Build a base58check P2PKH address with the given (single-byte) version. */
function p2pkh(pubkeyCompressed: Uint8Array, versionByte: number): string {
  const payload = new Uint8Array(21);
  payload[0] = versionByte;
  payload.set(hash160(pubkeyCompressed), 1);
  return base58check.encode(payload);
}

/**
 * Zcash transparent (t1...) address: 2-byte version prefix `0x1CB8`
 * concatenated with hash160(pubkey), then base58check.
 */
function zecTransparent(pubkeyCompressed: Uint8Array): string {
  const payload = new Uint8Array(22);
  payload[0] = 0x1c;
  payload[1] = 0xb8;
  payload.set(hash160(pubkeyCompressed), 2);
  return base58check.encode(payload);
}

/**
 * Cosmos-SDK style address: `bech32(hrp, hash160(pubkey))`. Swap the HRP
 * for OSMO / TIA / INJ / etc. The 1000-char limit lifts bech32's default
 * 90-char cap that segwit imposes — Cosmos has no such limit.
 */
function cosmosAddress(pubkeyCompressed: Uint8Array, hrp: string): string {
  return bech32.encode(
    hrp as `${string}`,
    bech32.toWords(hash160(pubkeyCompressed)),
    1000,
  ) as string;
}

/**
 * Derive an Ethereum address (EIP-55 mixed-case checksum) from the
 * uncompressed pubkey: `keccak256(pubkey[1:])[-20:]`.
 */
function ethAddress(pubkeyUncompressed: Uint8Array): string {
  const addr = keccak_256(pubkeyUncompressed.slice(1)).slice(-20);
  const addrHex = hex.encode(addr);
  const hashHex = hex.encode(keccak_256(new TextEncoder().encode(addrHex)));
  let out = '0x';
  for (let i = 0; i < addrHex.length; i++) {
    out += parseInt(hashHex[i], 16) >= 8 ? addrHex[i].toUpperCase() : addrHex[i];
  }
  return out;
}

/** A shitcoin chain Magikarp can derive an address for. */
export type ShitcoinId = 'DOGE' | 'LTC' | 'BCH' | 'BSV' | 'ETH' | 'ZEC' | 'ATOM';

/** A single derived shitcoin wallet. */
export interface ShitcoinWallet {
  /** Chain identifier. */
  id: ShitcoinId;
  /** Human-readable chain name. */
  name: string;
  /** The derived on-chain address. */
  address: string;
  /** Ticker symbol shown next to balances. Same as `id` for most chains. */
  ticker: string;
  /**
   * Single-glyph emoji icon shown next to the chain in pills, rows, and
   * tiles. Picked for maximum meme density: DOGE=🐕, ETH=🦄, ZEC=🥷, etc.
   */
  emoji: string;
  /**
   * BIP-21-style URI scheme for the chain's "Open in wallet" deeplink, or
   * `null` if the chain has no widely-adopted URI scheme (Cosmos). Used to
   * build links like `dogecoin:Dxxxx`, `ethereum:0xABCD`, `zcash:t1xxx`.
   */
  uriScheme: string | null;
  /**
   * The Coingecko coin ID. Doubles as the canonical chain slug for
   * kind-8333 `i` tags (`<coingeckoId>:tx:<txid>`), so post-zap rendering
   * can identify which chain a receipt is for.
   */
  coingeckoId: string;
  /**
   * Memey one-liner shown under the chain name in the wallet UI. Lean into
   * the joke — these are the satirical payoff of the whole "every npub is a
   * cross-chain wallet" bit.
   */
  tagline: string;
}

/**
 * Per-chain metadata. Version bytes come from each chain's address params:
 *   DOGE: 0x1E   ("D...")
 *   LTC : 0x30   ("L...")
 *   BCH : 0x00   (legacy base58check, "1..."; CashAddr "bitcoincash:q..." TODO)
 *   BSV : 0x00   ("1...", same byte as legacy BTC)
 *   ETH : keccak256(uncompressed_pubkey[1:])[-20:] with EIP-55 checksum
 *   ZEC : 2-byte version 0x1CB8 ‖ hash160(pubkey), base58check ("t1...")
 *   ATOM: bech32("cosmos", hash160(pubkey)) — HRP-swap → OSMO/TIA/INJ/etc.
 *
 * The `tagline`s are the memetic core of the joke fork — they are the
 * argument made visible. Edit with care; the joke is load-bearing.
 */
export const SHITCOIN_META: Record<
  ShitcoinId,
  { name: string; ticker: string; emoji: string; uriScheme: string | null; coingeckoId: string; tagline: string }
> = {
  DOGE: {
    name: 'Dogecoin',
    ticker: 'DOGE',
    emoji: '🐕',
    uriScheme: 'dogecoin',
    coingeckoId: 'dogecoin',
    tagline: 'much wallet. very chain. wow.',
  },
  LTC: {
    name: 'Litecoin',
    ticker: 'LTC',
    emoji: '🥈',
    uriScheme: 'litecoin',
    coingeckoId: 'litecoin',
    tagline: 'the silver to Bitcoin’s gold, the gold to Dogecoin’s memes.',
  },
  BCH: {
    name: 'Bitcoin Cash',
    ticker: 'BCH',
    emoji: '💵',
    // Legacy P2PKH ("1..."), so the URI scheme is `bitcoin:` not `bitcoincash:`.
    // Yes — your BCH address collides with a BTC address. That’s the joke.
    uriScheme: 'bitcoin',
    coingeckoId: 'bitcoin-cash',
    tagline: 'real Bitcoin™. (one of nine.)',
  },
  BSV: {
    name: 'Bitcoin SV',
    ticker: 'BSV',
    emoji: '👁️',
    uriScheme: 'bitcoin',
    coingeckoId: 'bitcoin-cash-sv',
    tagline: 'Satoshi’s Vision™. literally identical address byte-for-byte to BCH. yes really.',
  },
  ETH: {
    name: 'Ethereum',
    ticker: 'ETH',
    emoji: '🦄',
    uriScheme: 'ethereum',
    coingeckoId: 'ethereum',
    tagline: 'gas not included. number go up. ngmi.',
  },
  ZEC: {
    name: 'Zcash',
    ticker: 'ZEC',
    emoji: '🥷',
    uriScheme: 'zcash',
    coingeckoId: 'zcash',
    tagline: 'the privacy coin — transparent address edition. (lol.)',
  },
  ATOM: {
    name: 'Cosmos',
    ticker: 'ATOM',
    emoji: '⚛️',
    // Cosmos has no widely-adopted BIP-21-style URI. Wallets use WalletConnect.
    uriScheme: null,
    coingeckoId: 'cosmos',
    tagline: 'IBC into the moon. swap hrp → OSMO / TIA / INJ.',
  },
};

/**
 * Build a BIP-21-style URI for a wallet, or `null` if the chain has no
 * scheme. Used by the "Open in [Chain] Wallet" buttons in the UI.
 */
export function shitcoinUri(wallet: ShitcoinWallet, amount?: string): string | null {
  if (!wallet.uriScheme) return null;
  const base = `${wallet.uriScheme}:${wallet.address}`;
  return amount ? `${base}?amount=${encodeURIComponent(amount)}` : base;
}

/**
 * Derive all supported shitcoin addresses from a 32-byte hex x-only Nostr
 * pubkey. Returns an empty array if the pubkey is malformed or not a valid
 * point on the secp256k1 curve.
 *
 * Order matters: DOGE is first because Dogecoin is, definitionally, the
 * number one shitcoin. The wallet UI promotes the first entry to a featured
 * card and treats the rest as the long tail.
 */
export function nostrPubkeyToShitcoinAddresses(pubkeyHex: string): ShitcoinWallet[] {
  if (!isValidXOnlyHex(pubkeyHex)) return [];

  try {
    const xOnly = hexDecode(pubkeyHex);
    const { compressed, uncompressed } = pubkeysFromXOnly(xOnly);

    const make = (id: ShitcoinId, address: string): ShitcoinWallet => ({
      id,
      address,
      name: SHITCOIN_META[id].name,
      ticker: SHITCOIN_META[id].ticker,
      emoji: SHITCOIN_META[id].emoji,
      uriScheme: SHITCOIN_META[id].uriScheme,
      coingeckoId: SHITCOIN_META[id].coingeckoId,
      tagline: SHITCOIN_META[id].tagline,
    });

    return [
      make('DOGE', p2pkh(compressed, 0x1e)),
      make('LTC', p2pkh(compressed, 0x30)),
      make('BCH', p2pkh(compressed, 0x00)),
      make('BSV', p2pkh(compressed, 0x00)),
      make('ETH', ethAddress(uncompressed)),
      make('ZEC', zecTransparent(compressed)),
      make('ATOM', cosmosAddress(compressed, 'cosmos')),
    ];
  } catch (error) {
    console.error('Error deriving shitcoin addresses:', error);
    return [];
  }
}

/**
 * Derive a single shitcoin address by chain id from a hex x-only pubkey.
 * Returns an empty string on failure or unknown chain.
 */
export function nostrPubkeyToShitcoinAddress(pubkeyHex: string, chain: ShitcoinId): string {
  return nostrPubkeyToShitcoinAddresses(pubkeyHex).find((w) => w.id === chain)?.address ?? '';
}

/**
 * Derive all supported shitcoin addresses from a bech32 `npub1...` identifier.
 * The npub mode is the privacy argument made concrete: anyone with just your
 * npub can compute exactly where your money lives on seven chains.
 */
export function npubToShitcoinAddresses(npub: string): ShitcoinWallet[] {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('Invalid npub format');
  }
  return nostrPubkeyToShitcoinAddresses(decoded.data);
}
