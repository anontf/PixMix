// Deterministic PRNG: the ChaCha20 block function in counter mode (RFC 8439 layout).
// Integer-only arithmetic so every JS engine produces the same stream.

export class ChaChaRng {
  /** @param {Uint8Array} key 32 bytes @param {Uint8Array} nonce 12 bytes */
  constructor(key, nonce) {
    const kv = new DataView(key.buffer, key.byteOffset, 32);
    const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
    this.state = new Uint32Array(16);
    this.state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    for (let i = 0; i < 8; i++) this.state[4 + i] = kv.getUint32(i * 4, true);
    this.state[12] = 0;
    for (let i = 0; i < 3; i++) this.state[13 + i] = nv.getUint32(i * 4, true);
    this.block = new Uint32Array(16);
    this.pos = 16;
  }

  refill() {
    const s = this.state;
    let x0 = s[0] | 0, x1 = s[1] | 0, x2 = s[2] | 0, x3 = s[3] | 0;
    let x4 = s[4] | 0, x5 = s[5] | 0, x6 = s[6] | 0, x7 = s[7] | 0;
    let x8 = s[8] | 0, x9 = s[9] | 0, x10 = s[10] | 0, x11 = s[11] | 0;
    let x12 = s[12] | 0, x13 = s[13] | 0, x14 = s[14] | 0, x15 = s[15] | 0;
    for (let r = 0; r < 10; r++) {
      // column round
      x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16);
      x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
      x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24);
      x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
      x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16);
      x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
      x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24);
      x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
      x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16);
      x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
      x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24);
      x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
      x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16);
      x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
      x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24);
      x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
      // diagonal round
      x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16);
      x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
      x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24);
      x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
      x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16);
      x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
      x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24);
      x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
      x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16);
      x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
      x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24);
      x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
      x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16);
      x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
      x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24);
      x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
    }
    const b = this.block;
    b[0] = x0 + s[0]; b[1] = x1 + s[1]; b[2] = x2 + s[2]; b[3] = x3 + s[3];
    b[4] = x4 + s[4]; b[5] = x5 + s[5]; b[6] = x6 + s[6]; b[7] = x7 + s[7];
    b[8] = x8 + s[8]; b[9] = x9 + s[9]; b[10] = x10 + s[10]; b[11] = x11 + s[11];
    b[12] = x12 + s[12]; b[13] = x13 + s[13]; b[14] = x14 + s[14]; b[15] = x15 + s[15];
    s[12] = s[12] + 1;
    if (s[12] === 0) s[13] = s[13] + 1;
    this.pos = 0;
  }

  /** @returns {number} uniform uint32 */
  nextU32() {
    if (this.pos === 16) this.refill();
    return this.block[this.pos++];
  }

  /** Unbiased integer in [0, n) for 1 <= n <= 2^32: mask to the next power of two and
   * reject overshoots (fewer than 2 draws on average, no division). */
  below(n) {
    if (n <= 1) return 0;
    const m = n - 1;
    const mask = m >= 0x80000000 ? 0xffffffff : (1 << (32 - Math.clz32(m))) - 1;
    let r;
    do {
      if (this.pos === 16) this.refill();
      r = (this.block[this.pos++] & mask) >>> 0;
    } while (r > m);
    return r;
  }
}
