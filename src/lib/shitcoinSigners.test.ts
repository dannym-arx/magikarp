import { describe, it, expect } from 'vitest';
import { hex } from '@scure/base';

import { _rlpInternals } from './shitcoinSigners';

const { rlpEncode, uintToRlpBytes } = _rlpInternals;
const enc = (b: Uint8Array) => hex.encode(b);

/**
 * Regression tests for the hand-rolled RLP encoder. The ETH signing path
 * builds transactions from these primitives; a bug here would burn real
 * ETH on a malformed broadcast, so the canonical RLP test vectors live
 * here as a tripwire.
 *
 * Vectors are from the original Ethereum yellow paper / py-rlp test suite.
 */
describe('uintToRlpBytes — minimal big-endian unsigned int encoding', () => {
  it('encodes 0 as empty', () => {
    expect(uintToRlpBytes(0n)).toEqual(new Uint8Array(0));
  });
  it('encodes small values without leading zeros', () => {
    expect(uintToRlpBytes(1n)).toEqual(new Uint8Array([0x01]));
    expect(uintToRlpBytes(0x7fn)).toEqual(new Uint8Array([0x7f]));
    expect(uintToRlpBytes(0xffn)).toEqual(new Uint8Array([0xff]));
  });
  it('encodes multi-byte values', () => {
    expect(uintToRlpBytes(0x100n)).toEqual(new Uint8Array([0x01, 0x00]));
    expect(uintToRlpBytes(0x1024n)).toEqual(new Uint8Array([0x10, 0x24]));
  });
});

describe('rlpEncode — byte strings', () => {
  it('encodes empty string as 0x80', () => {
    expect(enc(rlpEncode(new Uint8Array(0)))).toBe('80');
  });
  it('encodes single byte 0x00 as itself', () => {
    expect(enc(rlpEncode(new Uint8Array([0x00])))).toBe('00');
  });
  it('encodes single byte 0x7f as itself', () => {
    expect(enc(rlpEncode(new Uint8Array([0x7f])))).toBe('7f');
  });
  it('prefixes single byte 0x80 with 0x81', () => {
    expect(enc(rlpEncode(new Uint8Array([0x80])))).toBe('8180');
  });
  it('encodes "dog" (3 bytes) with 0x83 prefix', () => {
    expect(enc(rlpEncode(new Uint8Array([0x64, 0x6f, 0x67])))).toBe('83646f67');
  });
  it('encodes 55-byte string with 0xb7 prefix', () => {
    const s = new Uint8Array(55).fill(0x61);
    const out = enc(rlpEncode(s));
    expect(out.startsWith('b7')).toBe(true); // 0x80 + 55
    expect(out).toHaveLength(2 + 55 * 2);
  });
  it('encodes 56-byte string with long-length prefix (0xb8 + len)', () => {
    const s = new Uint8Array(56).fill(0x61);
    const out = enc(rlpEncode(s));
    expect(out.startsWith('b838')).toBe(true); // 0xb8 = 0xb7+1, len=56=0x38
    expect(out).toHaveLength(4 + 56 * 2);
  });
});

describe('rlpEncode — lists', () => {
  it('encodes empty list as 0xc0', () => {
    expect(enc(rlpEncode([]))).toBe('c0');
  });
  it('encodes ["cat", "dog"] (yellow-paper vector)', () => {
    // 0xc8: list prefix, total payload = 8 bytes
    // 0x83 'c''a''t' 0x83 'd''o''g'
    const cat = new Uint8Array([0x63, 0x61, 0x74]);
    const dog = new Uint8Array([0x64, 0x6f, 0x67]);
    expect(enc(rlpEncode([cat, dog]))).toBe('c88363617483646f67');
  });
  it('encodes nested empty lists: [ [], [[]], [ [], [[]] ] ]', () => {
    // From py-rlp test vectors.
    expect(enc(rlpEncode([[], [[]], [[], [[]]]]))).toBe('c7c0c1c0c3c0c1c0');
  });
});
