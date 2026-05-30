/**
 * Shitcoin address derivation — DOGE, LTC, BCH, BSV, ETH from a Nostr key.
 *
 * Every npub is also: a DOGE wallet, an LTC wallet, a BCH wallet, a BSV wallet,
 * and an ETH wallet. This proves that "on-chain zaps" don't depend on the
 * chain — they depend on collapsing your identity key into your money key,
 * which every secp256k1 chain enables for free.
 *
 * Adapted from a standalone `derive.ts` demo into a browser module that reuses
 * Magikarp's existing crypto stack:
 *   - `@noble/curves/secp256k1` for EC point math (same `Point` class as
 *     `silentPayments.ts`),
 *   - `@noble/hashes` for sha256 / ripemd160 / keccak256,
 *   - `@scure/base` for base58check + hex.
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
import { base58check as base58checkFactory, hex } from '@scure/base';
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

/** Build a base58check P2PKH address with the given version byte. */
function p2pkh(pubkeyCompressed: Uint8Array, versionByte: number): string {
  const payload = new Uint8Array(21);
  payload[0] = versionByte;
  payload.set(hash160(pubkeyCompressed), 1);
  return base58check.encode(payload);
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
export type ShitcoinId = 'DOGE' | 'LTC' | 'BCH' | 'BSV' | 'ETH';

/** A single derived shitcoin wallet. */
export interface ShitcoinWallet {
  /** Chain identifier. */
  id: ShitcoinId;
  /** Human-readable chain name. */
  name: string;
  /** The derived on-chain address. */
  address: string;
}

/**
 * Per-chain metadata. Version bytes come from each chain's address params:
 *   DOGE: 0x1E ("D...")
 *   LTC : 0x30 ("L...")
 *   BCH : 0x00 (legacy base58check, "1..."; CashAddr "bitcoincash:q..." TODO)
 *   BSV : 0x00 ("1...", same byte as legacy BTC)
 *   ETH : keccak256(uncompressed_pubkey[1:])[-20:] with EIP-55 checksum
 */
export const SHITCOIN_META: Record<ShitcoinId, { name: string }> = {
  DOGE: { name: 'Dogecoin' },
  LTC: { name: 'Litecoin' },
  BCH: { name: 'Bitcoin Cash' },
  BSV: { name: 'Bitcoin SV' },
  ETH: { name: 'Ethereum' },
};

/**
 * Derive all supported shitcoin addresses from a 32-byte hex x-only Nostr
 * pubkey. Returns an empty array if the pubkey is malformed or not a valid
 * point on the secp256k1 curve.
 */
export function nostrPubkeyToShitcoinAddresses(pubkeyHex: string): ShitcoinWallet[] {
  if (!isValidXOnlyHex(pubkeyHex)) return [];

  try {
    const xOnly = hexDecode(pubkeyHex);
    const { compressed, uncompressed } = pubkeysFromXOnly(xOnly);

    return [
      { id: 'DOGE', name: SHITCOIN_META.DOGE.name, address: p2pkh(compressed, 0x1e) },
      { id: 'LTC', name: SHITCOIN_META.LTC.name, address: p2pkh(compressed, 0x30) },
      { id: 'BCH', name: SHITCOIN_META.BCH.name, address: p2pkh(compressed, 0x00) },
      { id: 'BSV', name: SHITCOIN_META.BSV.name, address: p2pkh(compressed, 0x00) },
      { id: 'ETH', name: SHITCOIN_META.ETH.name, address: ethAddress(uncompressed) },
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
 * npub can compute exactly where your money lives on five chains.
 */
export function npubToShitcoinAddresses(npub: string): ShitcoinWallet[] {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('Invalid npub format');
  }
  return nostrPubkeyToShitcoinAddresses(decoded.data);
}
