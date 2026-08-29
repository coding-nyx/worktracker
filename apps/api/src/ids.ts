/**
 * ULID generation. We use a simple 26-char Crockford base32
 * encoding of a 128-bit value (48 bits timestamp + 80 bits
 * randomness). Self-contained, no native dependencies.
 */

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING.charAt(bytes[i]! % ENCODING_LEN);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function nowIso(): string {
  return new Date().toISOString();
}
