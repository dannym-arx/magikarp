/**
 * Native sign + broadcast for the BTC-like shitcoins where we have working
 * public UTXO + push endpoints (DOGE, LTC, BSV).
 *
 * Why hand-rolled instead of `@scure/btc-signer`: that library's legacy
 * P2PKH path requires the full hex of each parent transaction (the
 * `nonWitnessUtxo` field), so signing a DOGE/LTC tx with N inputs means N+1
 * UTXO calls. Hand-rolling the legacy sighash (DOGE/LTC) and the BIP143
 * sighash (BSV) lets us work from UTXO `{value, scriptPubKey}` alone — one
 * call per address, no prev-tx fetches.
 *
 * ## Y-parity correction
 *
 * x-only Nostr pubkeys are derived assuming `0x02` (even-y). If the real
 * private key produced an odd-y point, signing with the raw `d` yields a
 * signature against the *wrong* pubkey. The fix: `signingKey = (n − d) mod n`.
 * We detect this by deriving the compressed pubkey from `d` — if its parity
 * byte is `0x03`, we negate before signing.
 *
 * ## Sighash flavors
 *
 * - **DOGE / LTC** — legacy SIGHASH_ALL: clone tx, blank other inputs'
 *   scriptSig, install scriptPubKey on the signing input, append `0x01`
 *   (SIGHASH_ALL), SHA256d.
 * - **BSV** — BIP143 sighash + FORKID: structured pre-image with hashed
 *   prev-outs / sequences / outputs, sighash flag = `0x41`
 *   (`SIGHASH_ALL | SIGHASH_FORKID`).
 *
 * No silent payments, no segwit, no taproot — these chains never adopted
 * any of it (LTC has segwit but our derived addresses are legacy P2PKH).
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { base58check as base58checkFactory, hex } from '@scure/base';

import { type ShitcoinId } from './shitcoins';
import { ERC20_TOKENS, findErc20Token, type Erc20Token } from './erc20Tokens';
// Re-export so downstream callers can grab the registry from a single place.
export { ERC20_TOKENS, findErc20Token, type Erc20Token };

const base58check = base58checkFactory(sha256);

// ---------------------------------------------------------------------------
// Curve / hash helpers
// ---------------------------------------------------------------------------

const CURVE_N = secp256k1.CURVE.n;
const sha256d = (data: Uint8Array): Uint8Array => sha256(sha256(data));
const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

/**
 * Return the signing key that corresponds to a force-even-y x-only pubkey.
 * If `priv`'s real point has odd y, negate the key so the derived public
 * key matches the address we displayed.
 */
function applyYParityCorrection(priv: Uint8Array): Uint8Array {
  const pub = secp256k1.getPublicKey(priv, true);
  if (pub[0] === 0x02) return priv;
  // Real y is odd — negate the key.
  const d = BigInt('0x' + hex.encode(priv));
  const corrected = (CURVE_N - d) % CURVE_N;
  return bigIntTo32Bytes(corrected);
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binary writer for transaction serialization
// ---------------------------------------------------------------------------

/** Append-only binary buffer with the standard Bitcoin tx encoding helpers. */
class BinaryWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  writeBytes(b: Uint8Array): void { this.chunks.push(b); this.length += b.length; }

  writeUint8(v: number): void { this.writeBytes(new Uint8Array([v & 0xff])); }

  writeUint32LE(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.writeBytes(b);
  }

  writeUint64LE(v: bigint): void {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, Number(v & 0xffffffffn), true);
    dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
    this.writeBytes(b);
  }

  /** Bitcoin CompactSize varint encoding. */
  writeVarInt(n: number): void {
    if (n < 0xfd) { this.writeUint8(n); return; }
    if (n <= 0xffff) {
      this.writeUint8(0xfd);
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, n, true);
      this.writeBytes(b);
      return;
    }
    if (n <= 0xffffffff) {
      this.writeUint8(0xfe);
      this.writeUint32LE(n);
      return;
    }
    throw new Error('varint out of range');
  }

  writeVarBytes(b: Uint8Array): void { this.writeVarInt(b.length); this.writeBytes(b); }

  /** TxId-as-binary is little-endian; everywhere displayed it is big-endian. */
  writeReversedHex(hexStr: string): void {
    const b = hex.decode(hexStr);
    const reversed = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) reversed[i] = b[b.length - 1 - i];
    this.writeBytes(reversed);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Script + DER encoding
// ---------------------------------------------------------------------------

const OP_DUP = 0x76;
const OP_HASH160 = 0xa9;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_PUSHBYTES_20 = 0x14;

/** P2PKH scriptPubKey: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG. */
function p2pkhScript(pubkeyHash: Uint8Array): Uint8Array {
  if (pubkeyHash.length !== 20) throw new Error('hash160 must be 20 bytes');
  const out = new Uint8Array(25);
  out[0] = OP_DUP;
  out[1] = OP_HASH160;
  out[2] = OP_PUSHBYTES_20;
  out.set(pubkeyHash, 3);
  out[23] = OP_EQUALVERIFY;
  out[24] = OP_CHECKSIG;
  return out;
}

/**
 * BIP66 / DER-encoded ECDSA signature with low-S enforcement.
 * The signature bytes are followed by a 1-byte sighash flag.
 */
function derSignature(r: bigint, s: bigint, sighashByte: number): Uint8Array {
  // Low-S (BIP62): if s > n/2, replace with n - s. Required by modern nodes.
  let sLow = s;
  if (s > CURVE_N / 2n) sLow = CURVE_N - s;

  const rBytes = trimAndPadDer(bigIntTo32Bytes(r));
  const sBytes = trimAndPadDer(bigIntTo32Bytes(sLow));

  const body = new Uint8Array(2 + rBytes.length + 2 + sBytes.length);
  body[0] = 0x02; body[1] = rBytes.length;
  body.set(rBytes, 2);
  body[2 + rBytes.length] = 0x02;
  body[3 + rBytes.length] = sBytes.length;
  body.set(sBytes, 4 + rBytes.length);

  const out = new Uint8Array(2 + body.length + 1);
  out[0] = 0x30;
  out[1] = body.length;
  out.set(body, 2);
  out[out.length - 1] = sighashByte;
  return out;
}

/** Trim leading zero bytes, then prepend one if the high bit is set. */
function trimAndPadDer(b: Uint8Array): Uint8Array {
  let start = 0;
  while (start < b.length - 1 && b[start] === 0) start++;
  let trimmed = b.slice(start);
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded[0] = 0;
    padded.set(trimmed, 1);
    trimmed = padded;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// UTXO + chain parameter shape
// ---------------------------------------------------------------------------

export interface Utxo {
  txid: string;
  vout: number;
  /** Atomic units (sats for BTC-likes). */
  value: bigint;
  /** scriptPubKey for the UTXO. P2PKH for everything here. */
  script: Uint8Array;
}

interface ChainParams {
  id: ShitcoinId;
  /** Human-readable name for error messages. */
  name: string;
  /** Address version byte for P2PKH. */
  pubKeyHashVersion: number;
  /** Legacy SHA256d sighash, or BIP143-with-FORKID (BCH/BSV style). */
  sighashKind: 'legacy' | 'bip143-forkid';
  /** Sighash byte appended to the DER signature (typically 0x01 or 0x41). */
  sighashByte: number;
  /** Sats/byte fee rate. */
  feeRate: number;
  /** Dust limit in sats. */
  dustLimit: bigint;
  /** UTXO fetcher returning current unspent outputs for the address. */
  fetchUtxos: (address: string, signal?: AbortSignal) => Promise<Utxo[]>;
  /** Broadcast a raw signed tx hex; returns the new txid. */
  broadcast: (txHex: string, signal?: AbortSignal) => Promise<string>;
  /** Explorer URL template; `{txid}` is replaced. */
  explorerTx: string;
}

// ---------------------------------------------------------------------------
// Per-chain UTXO + broadcast adapters
// ---------------------------------------------------------------------------

/** DOGE — blockcypher.com primary, dogechain.info fallback. */
async function fetchDogeUtxos(address: string, signal?: AbortSignal): Promise<Utxo[]> {
  // Blockcypher returns txrefs with tx_hash, tx_output_n, value (sats).
  try {
    const res = await fetch(
      `https://api.blockcypher.com/v1/doge/main/addrs/${address}?unspentOnly=true&includeScript=true`,
      { signal },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        txrefs?: Array<{ tx_hash: string; tx_output_n: number; value: number; script?: string }>;
      };
      const out: Utxo[] = [];
      for (const r of json.txrefs ?? []) {
        out.push({
          txid: r.tx_hash,
          vout: r.tx_output_n,
          value: BigInt(r.value),
          script: r.script ? hex.decode(r.script) : p2pkhScriptFromAddress(address, 'DOGE'),
        });
      }
      return out;
    }
  } catch { /* try fallback */ }

  // dogechain.info fallback
  const res = await fetch(`https://dogechain.info/api/v1/unspent/${address}`, { signal });
  if (!res.ok) throw new Error(`DOGE UTXO fetch failed (${res.status})`);
  const json = (await res.json()) as {
    success?: number;
    unspent_outputs?: Array<{ tx_hash: string; tx_output_n: number; value: number; script: string }>;
  };
  if (json.success !== 1) throw new Error('DOGE UTXO fetch failed (no success)');
  return (json.unspent_outputs ?? []).map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_output_n,
    value: BigInt(u.value),
    script: hex.decode(u.script),
  }));
}

async function broadcastDoge(txHex: string, signal?: AbortSignal): Promise<string> {
  // Try blockcypher first (returns {tx: {hash: ...}}).
  try {
    const res = await fetch('https://api.blockcypher.com/v1/doge/main/txs/push', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: txHex }),
    });
    if (res.ok) {
      const json = (await res.json()) as { tx?: { hash?: string } };
      if (json.tx?.hash) return json.tx.hash;
    }
  } catch { /* try fallback */ }

  // dogechain.info fallback: form-encoded `tx=HEX`, returns {success, tx_hash}.
  const res = await fetch('https://dogechain.info/api/v1/pushtx', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `tx=${encodeURIComponent(txHex)}`,
  });
  const json = (await res.json()) as { success?: number; tx_hash?: string; error?: string };
  if (json.success !== 1 || !json.tx_hash) {
    throw new Error(`DOGE broadcast failed: ${json.error ?? 'unknown'}`);
  }
  return json.tx_hash;
}

/** LTC — litecoinspace.org (Esplora) primary, blockcypher fallback. */
async function fetchLtcUtxos(address: string, signal?: AbortSignal): Promise<Utxo[]> {
  try {
    const res = await fetch(`https://litecoinspace.org/api/address/${address}/utxo`, { signal });
    if (res.ok) {
      const json = (await res.json()) as Array<{
        txid: string;
        vout: number;
        value: number;
      }>;
      // Esplora UTXO entries don't include scriptPubKey — derive from address.
      const script = p2pkhScriptFromAddress(address, 'LTC');
      return json.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: BigInt(u.value),
        script,
      }));
    }
  } catch { /* try fallback */ }

  const res = await fetch(
    `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=true&includeScript=true`,
    { signal },
  );
  if (!res.ok) throw new Error(`LTC UTXO fetch failed (${res.status})`);
  const json = (await res.json()) as {
    txrefs?: Array<{ tx_hash: string; tx_output_n: number; value: number; script?: string }>;
  };
  return (json.txrefs ?? []).map((r) => ({
    txid: r.tx_hash,
    vout: r.tx_output_n,
    value: BigInt(r.value),
    script: r.script ? hex.decode(r.script) : p2pkhScriptFromAddress(address, 'LTC'),
  }));
}

async function broadcastLtc(txHex: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch('https://litecoinspace.org/api/tx', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
    });
    if (res.ok) {
      // Esplora returns the txid as the response body (plain text).
      return (await res.text()).trim();
    }
  } catch { /* try fallback */ }

  const res = await fetch('https://api.blockcypher.com/v1/ltc/main/txs/push', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: txHex }),
  });
  if (!res.ok) throw new Error(`LTC broadcast failed (${res.status})`);
  const json = (await res.json()) as { tx?: { hash?: string } };
  if (!json.tx?.hash) throw new Error('LTC broadcast: missing tx hash in response');
  return json.tx.hash;
}

/** BSV — whatsonchain.com. */
async function fetchBsvUtxos(address: string, signal?: AbortSignal): Promise<Utxo[]> {
  const res = await fetch(
    `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`,
    { signal },
  );
  if (!res.ok) throw new Error(`BSV UTXO fetch failed (${res.status})`);
  const json = (await res.json()) as Array<{ tx_hash: string; tx_pos: number; value: number }>;
  const script = p2pkhScriptFromAddress(address, 'BSV');
  return json.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    value: BigInt(u.value),
    script,
  }));
}

async function broadcastBsv(txHex: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
  });
  if (!res.ok) throw new Error(`BSV broadcast failed (${res.status}): ${await res.text()}`);
  // whatsonchain returns the txid as a JSON-encoded string.
  const txt = (await res.text()).trim();
  return txt.startsWith('"') ? txt.slice(1, -1) : txt;
}

// ---------------------------------------------------------------------------
// Chain registry — only the chains we can actually sign+broadcast natively
// ---------------------------------------------------------------------------

const CHAIN_PARAMS: Partial<Record<ShitcoinId, ChainParams>> = {
  DOGE: {
    id: 'DOGE',
    name: 'Dogecoin',
    pubKeyHashVersion: 0x1e,
    sighashKind: 'legacy',
    sighashByte: 0x01,
    // DOGE minimum relay fee is high (~1 DOGE per kB historically). 100 sat/B
    // is a safe contemporary value for confirmation in a few blocks.
    feeRate: 100,
    dustLimit: 1_000_000n, // ~0.01 DOGE
    fetchUtxos: fetchDogeUtxos,
    broadcast: broadcastDoge,
    explorerTx: 'https://dogechain.info/tx/{txid}',
  },
  LTC: {
    id: 'LTC',
    name: 'Litecoin',
    pubKeyHashVersion: 0x30,
    sighashKind: 'legacy',
    sighashByte: 0x01,
    feeRate: 5,
    dustLimit: 5_460n,
    fetchUtxos: fetchLtcUtxos,
    broadcast: broadcastLtc,
    explorerTx: 'https://litecoinspace.org/tx/{txid}',
  },
  BSV: {
    id: 'BSV',
    name: 'Bitcoin SV',
    pubKeyHashVersion: 0x00,
    sighashKind: 'bip143-forkid',
    sighashByte: 0x41, // SIGHASH_ALL | SIGHASH_FORKID
    feeRate: 1,
    dustLimit: 546n,
    fetchUtxos: fetchBsvUtxos,
    broadcast: broadcastBsv,
    explorerTx: 'https://whatsonchain.com/tx/{txid}',
  },
};

/** Which chains support native signing in this fork. */
export const NATIVE_SIGNING_CHAINS: ShitcoinId[] = [
  ...(Object.keys(CHAIN_PARAMS) as ShitcoinId[]),
  'ETH',
];

/** True iff the given chain has a native sign+broadcast path. */
export function canSignShitcoin(chain: ShitcoinId): boolean {
  return chain === 'ETH' || CHAIN_PARAMS[chain] !== undefined;
}

// ---------------------------------------------------------------------------
// Address decoding (P2PKH → hash160) for input scripts when only address is known
// ---------------------------------------------------------------------------

/**
 * Decode a P2PKH address to its scriptPubKey. Some UTXO endpoints don't
 * include the script — we rebuild it from the address.
 */
function p2pkhScriptFromAddress(address: string, chain: ShitcoinId): Uint8Array {
  const params = CHAIN_PARAMS[chain];
  if (!params) throw new Error(`No params for chain ${chain}`);
  const decoded = base58check.decode(address);
  if (decoded[0] !== params.pubKeyHashVersion) {
    throw new Error(`Address ${address} version 0x${decoded[0].toString(16)} != chain ${chain} version 0x${params.pubKeyHashVersion.toString(16)}`);
  }
  return p2pkhScript(decoded.slice(1));
}

/** Decode any P2PKH address to its 20-byte hash160. */
function p2pkhHashFromAddress(address: string, chain: ShitcoinId): Uint8Array {
  const params = CHAIN_PARAMS[chain];
  if (!params) throw new Error(`No params for chain ${chain}`);
  const decoded = base58check.decode(address);
  if (decoded[0] !== params.pubKeyHashVersion) {
    throw new Error(`Address ${address} is not a valid ${chain} P2PKH address`);
  }
  return decoded.slice(1);
}

// ---------------------------------------------------------------------------
// Transaction construction (unsigned)
// ---------------------------------------------------------------------------

interface TxInput {
  txid: string;
  vout: number;
  /** Source UTXO value (needed for BIP143 sighash). */
  value: bigint;
  /** scriptPubKey of the source UTXO (the script we sign against). */
  prevScript: Uint8Array;
  /** Final scriptSig — filled in during signing. */
  scriptSig: Uint8Array;
  /** Sequence number; 0xffffffff (default = no RBF, no locktime use). */
  sequence: number;
}

interface TxOutput {
  value: bigint;
  scriptPubKey: Uint8Array;
}

/** Serialize a transaction (signed or unsigned) to its on-wire byte form. */
function serializeTx(version: number, inputs: TxInput[], outputs: TxOutput[], locktime: number): Uint8Array {
  const w = new BinaryWriter();
  w.writeUint32LE(version);
  w.writeVarInt(inputs.length);
  for (const inp of inputs) {
    w.writeReversedHex(inp.txid);
    w.writeUint32LE(inp.vout);
    w.writeVarBytes(inp.scriptSig);
    w.writeUint32LE(inp.sequence);
  }
  w.writeVarInt(outputs.length);
  for (const out of outputs) {
    w.writeUint64LE(out.value);
    w.writeVarBytes(out.scriptPubKey);
  }
  w.writeUint32LE(locktime);
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// Sighash computation
// ---------------------------------------------------------------------------

/** Legacy SIGHASH_ALL preimage (DOGE / LTC). */
function legacySighash(
  version: number,
  inputs: TxInput[],
  outputs: TxOutput[],
  locktime: number,
  signingIndex: number,
  sighashByte: number,
): Uint8Array {
  // Clone inputs; blank all scriptSigs except the signing input, where we
  // install the source scriptPubKey.
  const clones: TxInput[] = inputs.map((inp, i) => ({
    ...inp,
    scriptSig: i === signingIndex ? inp.prevScript : new Uint8Array(0),
  }));
  const preimage = serializeTx(version, clones, outputs, locktime);
  const w = new BinaryWriter();
  w.writeBytes(preimage);
  w.writeUint32LE(sighashByte); // 4 bytes for sighash type
  return sha256d(w.toBytes());
}

/**
 * BIP143 sighash preimage (BSV with FORKID).
 * preimage = nVersion | hashPrevouts | hashSequence | outpoint | scriptCode
 *          | value | nSequence | hashOutputs | nLocktime | sighashType
 */
function bip143Sighash(
  version: number,
  inputs: TxInput[],
  outputs: TxOutput[],
  locktime: number,
  signingIndex: number,
  sighashByte: number,
): Uint8Array {
  // hashPrevouts = SHA256d(all outpoints concatenated)
  const wPrev = new BinaryWriter();
  for (const inp of inputs) {
    wPrev.writeReversedHex(inp.txid);
    wPrev.writeUint32LE(inp.vout);
  }
  const hashPrevouts = sha256d(wPrev.toBytes());

  // hashSequence = SHA256d(all sequences concatenated)
  const wSeq = new BinaryWriter();
  for (const inp of inputs) wSeq.writeUint32LE(inp.sequence);
  const hashSequence = sha256d(wSeq.toBytes());

  // hashOutputs = SHA256d(serialized outputs)
  const wOut = new BinaryWriter();
  for (const out of outputs) {
    wOut.writeUint64LE(out.value);
    wOut.writeVarBytes(out.scriptPubKey);
  }
  const hashOutputs = sha256d(wOut.toBytes());

  const inp = inputs[signingIndex];
  const w = new BinaryWriter();
  w.writeUint32LE(version);
  w.writeBytes(hashPrevouts);
  w.writeBytes(hashSequence);
  w.writeReversedHex(inp.txid);
  w.writeUint32LE(inp.vout);
  w.writeVarBytes(inp.prevScript);
  w.writeUint64LE(inp.value);
  w.writeUint32LE(inp.sequence);
  w.writeBytes(hashOutputs);
  w.writeUint32LE(locktime);
  w.writeUint32LE(sighashByte);
  return sha256d(w.toBytes());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Estimated transaction size in bytes (P2PKH legacy: 10 overhead + 148/input + 34/output). */
function estimateTxSize(numInputs: number, numOutputs: number): number {
  return 10 + 148 * numInputs + 34 * numOutputs;
}

export interface SignAndBroadcastParams {
  chain: ShitcoinId;
  /** Raw 32-byte nsec (force-even-y derivation, y-parity corrected internally). */
  privateKey: Uint8Array;
  /** Sender address (must match `privateKey` under force-even-y derivation). */
  fromAddress: string;
  /** Recipient P2PKH address on the same chain. */
  toAddress: string;
  /** Amount in atomic units (sats). */
  amount: bigint;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface SignAndBroadcastResult {
  txid: string;
  explorerUrl: string;
  feePaid: bigint;
}

/**
 * Sign and broadcast a P2PKH transaction on a supported BTC-like chain.
 * Throws if the chain is not natively supported, the wallet has no UTXOs,
 * or any step (UTXO fetch / signing / broadcast) fails.
 */
export async function signAndBroadcastShitcoin(
  params: SignAndBroadcastParams,
): Promise<SignAndBroadcastResult> {
  // ETH takes the account-model path (nonce + gasPrice + RLP + keccak),
  // implemented separately because it shares almost nothing with the
  // UTXO-based BTC-like flow.
  if (params.chain === 'ETH') {
    return signAndBroadcastEth(params);
  }

  const cp = CHAIN_PARAMS[params.chain];
  if (!cp) {
    throw new Error(
      `${params.chain} signing is not implemented in this fork yet. ` +
        `Try DOGE / LTC / BSV / ETH — those work. The others need their own signing pipelines.`,
    );
  }

  // Y-parity correct the key once.
  const signingKey = applyYParityCorrection(params.privateKey);
  const pubkey = secp256k1.getPublicKey(signingKey, true);
  if (pubkey[0] !== 0x02) {
    throw new Error('Y-parity correction failed — derived pubkey still odd-y');
  }

  // Sanity check: derived address must match the supplied fromAddress.
  const derivedHash = hash160(pubkey);
  const expectedHash = p2pkhHashFromAddress(params.fromAddress, params.chain);
  if (hex.encode(derivedHash) !== hex.encode(expectedHash)) {
    throw new Error(
      `Derived ${params.chain} address does not match supplied fromAddress — key/address mismatch`,
    );
  }

  // Fetch UTXOs.
  const utxos = await cp.fetchUtxos(params.fromAddress, params.signal);
  if (utxos.length === 0) {
    throw new Error(`No spendable ${cp.name} UTXOs at ${params.fromAddress}`);
  }

  // Coin selection: largest-first until we cover (amount + estimated fee).
  utxos.sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const recipientScript = p2pkhScript(p2pkhHashFromAddress(params.toAddress, params.chain));
  const senderScript = p2pkhScript(derivedHash);

  // Pessimistic estimate: assume 2 outputs (recipient + change) for fee.
  const selected: Utxo[] = [];
  let selectedSum = 0n;
  let fee = 0n;
  for (const u of utxos) {
    selected.push(u);
    selectedSum += u.value;
    fee = BigInt(estimateTxSize(selected.length, 2) * cp.feeRate);
    if (selectedSum >= params.amount + fee) break;
  }
  if (selectedSum < params.amount + fee) {
    throw new Error(
      `Insufficient ${cp.name} balance: need ${params.amount + fee} sats, have ${selectedSum}`,
    );
  }

  // Build outputs. Drop change if below dust limit — donate to miner fee.
  const outputs: TxOutput[] = [{ value: params.amount, scriptPubKey: recipientScript }];
  let change = selectedSum - params.amount - fee;
  if (change >= cp.dustLimit) {
    outputs.push({ value: change, scriptPubKey: senderScript });
  } else {
    // Re-estimate fee with 1 output, recompute change; if still below dust,
    // absorb it into the fee.
    const fee1 = BigInt(estimateTxSize(selected.length, 1) * cp.feeRate);
    const change1 = selectedSum - params.amount - fee1;
    if (change1 >= cp.dustLimit) {
      fee = fee1;
      change = change1;
      outputs.push({ value: change, scriptPubKey: senderScript });
    } else {
      // No change output — entire surplus becomes additional fee.
      fee = selectedSum - params.amount;
    }
  }

  // Assemble inputs with empty scriptSig (filled in per signing step).
  const inputs: TxInput[] = selected.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    prevScript: u.script.length > 0 ? u.script : senderScript,
    scriptSig: new Uint8Array(0),
    sequence: 0xffffffff,
  }));

  // Sign each input.
  const version = 1; // legacy version 1 works on all three chains
  const locktime = 0;
  for (let i = 0; i < inputs.length; i++) {
    const hashToSign =
      cp.sighashKind === 'legacy'
        ? legacySighash(version, inputs, outputs, locktime, i, cp.sighashByte)
        : bip143Sighash(version, inputs, outputs, locktime, i, cp.sighashByte);
    const sig = secp256k1.sign(hashToSign, signingKey, { lowS: true });
    const sigBytes = derSignature(sig.r, sig.s, cp.sighashByte);

    // scriptSig = <push sig+sighash> <push pubkey>
    const w = new BinaryWriter();
    w.writeVarBytes(sigBytes);
    w.writeVarBytes(pubkey);
    inputs[i].scriptSig = w.toBytes();
  }

  const txBytes = serializeTx(version, inputs, outputs, locktime);
  const txHex = hex.encode(txBytes);

  // Broadcast.
  const txid = await cp.broadcast(txHex, params.signal);

  return {
    txid,
    explorerUrl: cp.explorerTx.replace('{txid}', txid),
    feePaid: fee,
  };
}

// ---------------------------------------------------------------------------
// Ethereum — RLP, EIP-155 legacy tx, JSON-RPC adapter
// ---------------------------------------------------------------------------

/**
 * Minimal big-endian encoding of an unsigned integer. Zero encodes to an
 * empty byte string per RLP convention.
 */
function uintToRlpBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('uintToRlpBytes: negative');
  if (n === 0n) return new Uint8Array(0);
  const out: number[] = [];
  let v = n;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(out);
}

/** Concatenate Uint8Arrays. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** RLP length prefix for items >= 56 bytes (used by both string and list). */
function rlpLongLengthPrefix(len: number, baseOffset: number): Uint8Array {
  const lenBytes = uintToRlpBytes(BigInt(len));
  return concatBytes([new Uint8Array([baseOffset + 55 + lenBytes.length]), lenBytes]);
}

/**
 * RLP encode a byte string OR a list of items (where each item is itself
 * either a byte string or a nested list). The recursive encoding is what
 * lets us encode `[nonce, gasPrice, gasLimit, to, value, data, v, r, s]`
 * with one call.
 */
type RlpItem = Uint8Array | RlpItem[];

function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    // Single byte 0x00–0x7f → itself.
    if (item.length === 1 && item[0] < 0x80) return item;
    if (item.length < 56) {
      return concatBytes([new Uint8Array([0x80 + item.length]), item]);
    }
    return concatBytes([rlpLongLengthPrefix(item.length, 0x80), item]);
  }
  // List.
  const encodedItems = item.map(rlpEncode);
  const payload = concatBytes(encodedItems);
  if (payload.length < 56) {
    return concatBytes([new Uint8Array([0xc0 + payload.length]), payload]);
  }
  return concatBytes([rlpLongLengthPrefix(payload.length, 0xc0), payload]);
}

// Exposed for tests — RLP correctness is critical because a bad tx wastes
// real ETH to broadcast (and a malformed signature might burn fees on a
// failed inclusion).
export const _rlpInternals = { rlpEncode, uintToRlpBytes };

// NOTE: the Ankr URL embeds a paid-tier API key. It will end up in the
// production JS bundle and is visible to anyone with browser devtools —
// acceptable for this joke fork's demo posture (the bundle is public
// either way), but if you ever move this to a serious project, proxy the
// RPC call through a server you control so the key isn't shipped to
// clients. cloudflare-eth is keyless and stays as the failover.
const ETH_RPC_URLS = [
  'https://rpc.ankr.com/eth/2cb50a1e7fddfab168ddc4d2731b66f49e78df462cbbb1f8b43b22ce721e0d5a',
  'https://cloudflare-eth.com',
];

const ETH_CHAIN_ID = 1n; // Ethereum mainnet
const ETH_GAS_LIMIT = 21000n; // plain transfer with empty data

/**
 * JSON-RPC over HTTP with per-URL failover. Each entry in `ETH_RPC_URLS` is
 * tried in order until one returns a non-error result.
 */
async function ethRpc(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  let lastError: unknown = null;
  for (const url of ETH_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      if (!res.ok) {
        lastError = new Error(`ETH RPC ${method} via ${url}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) {
        lastError = new Error(`ETH RPC ${method}: ${json.error.message ?? 'unknown error'}`);
        // Provider-level error (e.g. "insufficient funds") shouldn't fail
        // over — that's the actual answer. Throw immediately.
        throw lastError;
      }
      return json.result;
    } catch (err) {
      lastError = err;
      // Network error → try next provider.
    }
  }
  throw lastError ?? new Error(`ETH RPC ${method}: all providers failed`);
}

async function fetchEthNonce(address: string, signal?: AbortSignal): Promise<bigint> {
  const result = await ethRpc('eth_getTransactionCount', [address.toLowerCase(), 'pending'], signal);
  if (typeof result !== 'string') throw new Error('eth_getTransactionCount: bad response');
  return BigInt(result);
}

async function fetchEthGasPrice(signal?: AbortSignal): Promise<bigint> {
  const result = await ethRpc('eth_gasPrice', [], signal);
  if (typeof result !== 'string') throw new Error('eth_gasPrice: bad response');
  return BigInt(result);
}

async function broadcastEthTx(rawHex: string, signal?: AbortSignal): Promise<string> {
  const prefixed = rawHex.startsWith('0x') ? rawHex : `0x${rawHex}`;
  const result = await ethRpc('eth_sendRawTransaction', [prefixed], signal);
  if (typeof result !== 'string') throw new Error('eth_sendRawTransaction: bad response');
  return result; // 0x-prefixed txid
}

/** Decode an ETH address ("0x..." or just hex) to its 20-byte form. */
function ethAddressBytes(addr: string): Uint8Array {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid ETH address: ${addr}`);
  }
  return hex.decode(clean);
}

/**
 * Sign and broadcast a legacy EIP-155 Ethereum transaction (plain transfer,
 * no data, no contract interaction). Derives the spending key from the
 * Magikarp force-even-y assumption via the same `applyYParityCorrection`
 * used by the BTC-like chains — works for ETH because the corrected key's
 * uncompressed pubkey has the even-y coordinate that the displayed address
 * was derived from.
 */
async function signAndBroadcastEth(params: SignAndBroadcastParams): Promise<SignAndBroadcastResult> {
  const signingKey = applyYParityCorrection(params.privateKey);
  // Uncompressed pubkey (no `0x04` prefix when computing ETH address).
  const pubUncompressed = secp256k1.getPublicKey(signingKey, false);
  const derivedAddr = keccak_256(pubUncompressed.slice(1)).slice(-20);
  const expectedAddr = ethAddressBytes(params.fromAddress);
  if (hex.encode(derivedAddr) !== hex.encode(expectedAddr)) {
    throw new Error('Derived ETH address does not match supplied fromAddress — key/address mismatch');
  }

  const toBytes = ethAddressBytes(params.toAddress);

  const [nonce, gasPrice] = await Promise.all([
    fetchEthNonce(params.fromAddress, params.signal),
    fetchEthGasPrice(params.signal),
  ]);

  // EIP-155 unsigned preimage: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
  const unsigned: RlpItem = [
    uintToRlpBytes(nonce),
    uintToRlpBytes(gasPrice),
    uintToRlpBytes(ETH_GAS_LIMIT),
    toBytes,
    uintToRlpBytes(params.amount),
    new Uint8Array(0), // empty data
    uintToRlpBytes(ETH_CHAIN_ID),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  const sighash = keccak_256(rlpEncode(unsigned));

  const sig = secp256k1.sign(sighash, signingKey, { lowS: true });
  // EIP-155: v = recovery + chainId * 2 + 35
  const v = BigInt(sig.recovery) + ETH_CHAIN_ID * 2n + 35n;

  // Signed wire form: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
  const signed: RlpItem = [
    uintToRlpBytes(nonce),
    uintToRlpBytes(gasPrice),
    uintToRlpBytes(ETH_GAS_LIMIT),
    toBytes,
    uintToRlpBytes(params.amount),
    new Uint8Array(0),
    uintToRlpBytes(v),
    uintToRlpBytes(sig.r),
    uintToRlpBytes(sig.s),
  ];
  const rawHex = hex.encode(rlpEncode(signed));

  const txid = await broadcastEthTx(rawHex, params.signal);
  const cleanTxid = txid.replace(/^0x/, '');

  return {
    txid: cleanTxid,
    explorerUrl: `https://etherscan.io/tx/0x${cleanTxid}`,
    feePaid: ETH_GAS_LIMIT * gasPrice,
  };
}

// ---------------------------------------------------------------------------
// ERC-20 tokens — registry, ABI encoding, balance, sign+broadcast
// ---------------------------------------------------------------------------

// ABI encoding helpers — generic enough to hand-roll for transfer + balanceOf,
// the only two methods we call. Avoids pulling in viem/ethers just for these.

/** Left-pad bytes to 32 with zeros (ABI word size). */
function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error('ABI value > 32 bytes');
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** 32-byte big-endian unsigned int encoding. */
function uint256Bytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('uint256Bytes: negative');
  return leftPad32(uintToRlpBytes(n));
}

/**
 * Encode an ERC-20 `transfer(address,uint256)` call.
 * Function selector `0xa9059cbb` is `keccak256("transfer(address,uint256)")[:4]`
 * — hardcoded so we don't recompute on every call.
 */
function encodeErc20Transfer(to: Uint8Array, amount: bigint): Uint8Array {
  const out = new Uint8Array(4 + 32 + 32);
  out[0] = 0xa9; out[1] = 0x05; out[2] = 0x9c; out[3] = 0xbb;
  // Address occupies the rightmost 20 bytes of the first 32-byte word.
  out.set(to, 4 + 12);
  out.set(uint256Bytes(amount), 4 + 32);
  return out;
}

/**
 * Encode an ERC-20 `balanceOf(address)` call.
 * Selector `0x70a08231` is `keccak256("balanceOf(address)")[:4]`.
 */
function encodeErc20BalanceOf(address: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 32);
  out[0] = 0x70; out[1] = 0xa0; out[2] = 0x82; out[3] = 0x31;
  out.set(address, 4 + 12);
  return out;
}

/**
 * Fetch an ERC-20 balance via `eth_call` to `balanceOf(address)` on the
 * token contract. Returns atomic units (BigInt).
 */
export async function fetchErc20Balance(
  token: Erc20Token,
  address: string,
  signal?: AbortSignal,
): Promise<bigint> {
  const addrBytes = ethAddressBytes(address);
  const callData = encodeErc20BalanceOf(addrBytes);
  const result = await ethRpc(
    'eth_call',
    [
      {
        to: token.contract.toLowerCase(),
        data: '0x' + hex.encode(callData),
      },
      'latest',
    ],
    signal,
  );
  if (typeof result !== 'string') throw new Error('eth_call balanceOf: bad response');
  // result is a 32-byte hex (`0x` + 64 hex chars).
  return BigInt(result);
}

/** Gas limit for a plain ERC-20 transfer. Real-world usage typically lands
 *  around 50k–60k; 70k provides headroom for tokens with extra hooks. */
const ERC20_GAS_LIMIT = 70_000n;

/**
 * Sign and broadcast an ERC-20 transfer. Same EIP-155 envelope as the
 * native ETH path, but `to = token.contract`, `value = 0`, `data = ABI-
 * encoded transfer(recipient, amount)`, and higher gas limit because
 * ERC-20 transfers do real SSTOREs.
 */
export async function signAndBroadcastErc20(params: {
  token: Erc20Token;
  privateKey: Uint8Array;
  fromAddress: string;
  toAddress: string;
  /** Atomic units (e.g. for USDT with 6 decimals, `1000000n` = 1 USDT). */
  amount: bigint;
  signal?: AbortSignal;
}): Promise<SignAndBroadcastResult> {
  const signingKey = applyYParityCorrection(params.privateKey);
  const pubUncompressed = secp256k1.getPublicKey(signingKey, false);
  const derivedAddr = keccak_256(pubUncompressed.slice(1)).slice(-20);
  const expectedAddr = ethAddressBytes(params.fromAddress);
  if (hex.encode(derivedAddr) !== hex.encode(expectedAddr)) {
    throw new Error('Derived ETH address does not match supplied fromAddress — key/address mismatch');
  }

  const recipientBytes = ethAddressBytes(params.toAddress);
  const contractBytes = ethAddressBytes(params.token.contract);
  const callData = encodeErc20Transfer(recipientBytes, params.amount);

  const [nonce, gasPrice] = await Promise.all([
    fetchEthNonce(params.fromAddress, params.signal),
    fetchEthGasPrice(params.signal),
  ]);

  // EIP-155 unsigned preimage with value=0 and data=callData (call to the
  // token contract). chainId=1 for mainnet.
  const unsigned: RlpItem = [
    uintToRlpBytes(nonce),
    uintToRlpBytes(gasPrice),
    uintToRlpBytes(ERC20_GAS_LIMIT),
    contractBytes,
    uintToRlpBytes(0n),
    callData,
    uintToRlpBytes(ETH_CHAIN_ID),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  const sighash = keccak_256(rlpEncode(unsigned));

  const sig = secp256k1.sign(sighash, signingKey, { lowS: true });
  const v = BigInt(sig.recovery) + ETH_CHAIN_ID * 2n + 35n;

  const signed: RlpItem = [
    uintToRlpBytes(nonce),
    uintToRlpBytes(gasPrice),
    uintToRlpBytes(ERC20_GAS_LIMIT),
    contractBytes,
    uintToRlpBytes(0n),
    callData,
    uintToRlpBytes(v),
    uintToRlpBytes(sig.r),
    uintToRlpBytes(sig.s),
  ];
  const rawHex = hex.encode(rlpEncode(signed));

  const txid = await broadcastEthTx(rawHex, params.signal);
  const cleanTxid = txid.replace(/^0x/, '');

  return {
    txid: cleanTxid,
    explorerUrl: `https://etherscan.io/tx/0x${cleanTxid}`,
    feePaid: ERC20_GAS_LIMIT * gasPrice,
  };
}
