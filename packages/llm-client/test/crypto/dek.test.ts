import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DEK_BYTES,
  DekInvariantError,
  GCM_AUTH_TAG_BYTES,
  GCM_NONCE_BYTES,
  decryptWithDek,
  encryptWithDek,
  generateDek,
  zeroize,
} from '../../src/crypto/dek.js';

describe('generateDek', () => {
  it('produces a 32-byte Buffer', () => {
    const dek = generateDek();
    expect(dek).toBeInstanceOf(Buffer);
    expect(dek.length).toBe(DEK_BYTES);
  });

  it('returns different values on repeated calls', () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.equals(b)).toBe(false);
  });
});

describe('encryptWithDek / decryptWithDek', () => {
  it('roundtrips arbitrary plaintext', () => {
    const dek = generateDek();
    const plaintext = Buffer.from('sk-ant-0123456789abcdef', 'utf8');
    const env = encryptWithDek(plaintext, dek);

    expect(env.nonce.length).toBe(GCM_NONCE_BYTES);
    expect(env.authTag.length).toBe(GCM_AUTH_TAG_BYTES);
    expect(env.ciphertext.length).toBe(plaintext.length);
    expect(env.ciphertext.equals(plaintext)).toBe(false);

    const roundtripped = decryptWithDek(env, dek);
    expect(roundtripped.equals(plaintext)).toBe(true);
  });

  it('(property) roundtrip holds for arbitrary byte sequences', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 1024 }),
        (bytes) => {
          const dek = generateDek();
          const plain = Buffer.from(bytes);
          const env = encryptWithDek(plain, dek);
          const back = decryptWithDek(env, dek);
          expect(back.equals(plain)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('uses a fresh nonce each call (nonce reuse = catastrophic)', () => {
    const dek = generateDek();
    const plaintext = Buffer.from('same plaintext');
    const a = encryptWithDek(plaintext, dek);
    const b = encryptWithDek(plaintext, dek);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects DEK of wrong length', () => {
    const badDek = randomBytes(16);
    expect(() => encryptWithDek(Buffer.from('x'), badDek)).toThrow(
      DekInvariantError,
    );
  });

  it('rejects non-Buffer plaintext', () => {
    const dek = generateDek();
    // Cast to the declared shape so the *runtime* guard is what we
    // exercise, not the compiler. `@ts-expect-error` is unstable here
    // across Buffer-type environments (Iter 1 hit the same false-
    // positive), hence the explicit cast.
    expect(() =>
      encryptWithDek('not a buffer' as unknown as Buffer, dek),
    ).toThrow(DekInvariantError);
  });

  it('fails GCM auth when ciphertext is tampered', () => {
    const dek = generateDek();
    const env = encryptWithDek(Buffer.from('hello'), dek);
    const tampered = {
      ...env,
      ciphertext: Buffer.from(env.ciphertext.map((b: number) => b ^ 0x01)),
    };
    expect(() => decryptWithDek(tampered, dek)).toThrow();
  });

  it('fails GCM auth when authTag is tampered', () => {
    const dek = generateDek();
    const env = encryptWithDek(Buffer.from('hello'), dek);
    const tag = Buffer.from(env.authTag);
    tag[0] = tag[0]! ^ 0x01;
    expect(() =>
      decryptWithDek({ ...env, authTag: tag }, dek),
    ).toThrow();
  });

  it('fails when decrypting with a different DEK', () => {
    const env = encryptWithDek(Buffer.from('hello'), generateDek());
    expect(() => decryptWithDek(env, generateDek())).toThrow();
  });

  it('rejects wrong-size nonce / authTag on decrypt', () => {
    const dek = generateDek();
    const env = encryptWithDek(Buffer.from('x'), dek);
    expect(() =>
      decryptWithDek({ ...env, nonce: Buffer.alloc(8) }, dek),
    ).toThrow(DekInvariantError);
    expect(() =>
      decryptWithDek({ ...env, authTag: Buffer.alloc(8) }, dek),
    ).toThrow(DekInvariantError);
  });
});

describe('zeroize', () => {
  it('overwrites a Buffer with zeros', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    zeroize(buf);
    expect(buf.equals(Buffer.alloc(5))).toBe(true);
  });

  it('overwrites a Uint8Array with zeros', () => {
    const arr = new Uint8Array([9, 9, 9]);
    zeroize(arr);
    expect(arr.every((b) => b === 0)).toBe(true);
  });

  it('tolerates null / undefined', () => {
    expect(() => zeroize(null)).not.toThrow();
    expect(() => zeroize(undefined)).not.toThrow();
  });
});
