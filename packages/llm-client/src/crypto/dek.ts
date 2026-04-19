/**
 * DEK (Data Encryption Key) primitives.
 *
 * Implements §5.1 of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md`} — a DEK is a
 * random 256-bit AES key used **once per user key** to encrypt the
 * provider API key under AES-256-GCM with a random nonce. The DEK is
 * itself encrypted with a KEK in AWS KMS (see `./kek.ts`).
 *
 * This module is **pure crypto**: no KMS, no I/O, no metrics. It is
 * the smallest surface that still exercises GCM end-to-end and is
 * safe to call from any layer (edge, worker, batch).
 *
 * Invariants enforced here:
 *
 *  - DEK length is 32 bytes (AES-256). Any other length throws.
 *  - Nonce length is 12 bytes (GCM recommended IV size).
 *  - AuthTag length is 16 bytes (GCM default).
 *  - {@link zeroize} is the only sanctioned way to clear a key buffer.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256 requires a 32-byte key. */
export const DEK_BYTES = 32;

/** AES-GCM recommended nonce size. */
export const GCM_NONCE_BYTES = 12;

/** AES-GCM default auth-tag size. */
export const GCM_AUTH_TAG_BYTES = 16;

/**
 * AES-256-GCM ciphertext triple produced by {@link encryptWithDek}.
 *
 * Stored in DB as three independent columns (`keyCiphertext`,
 * `keyNonce`, `keyAuthTag`) per §5.1 step 6.
 */
export interface DekCiphertext {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
}

/**
 * Raised when a DEK-level invariant is violated. This indicates a
 * programming error (wrong key length, tampered ciphertext, etc.) and
 * is **not** mapped to `LLMCallError` here — upstream layers decide
 * whether the failure is user-visible or `internal`.
 */
export class DekInvariantError extends Error {
  override readonly name = 'DekInvariantError';
}

function assertDek(dek: Buffer): void {
  if (!(dek instanceof Buffer) || dek.length !== DEK_BYTES) {
    throw new DekInvariantError(
      `DEK must be a ${DEK_BYTES}-byte Buffer (got length=${
        dek instanceof Buffer ? dek.length : typeof dek
      }).`,
    );
  }
}

/**
 * Generate a fresh 256-bit DEK from a CSPRNG.
 *
 * Per §5.1 step 3, called once per `.setKey()` / key rotation. The
 * caller owns the buffer's lifecycle and MUST {@link zeroize} it when
 * finished.
 */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/**
 * Encrypt `plaintext` with `dek` under AES-256-GCM.
 *
 * The nonce is freshly generated per call (never re-used for the same
 * DEK — GCM nonce-reuse is catastrophic). The auth tag is returned
 * separately from the ciphertext so callers can store each column
 * independently in DB without ambiguous boundaries.
 */
export function encryptWithDek(plaintext: Buffer, dek: Buffer): DekCiphertext {
  assertDek(dek);
  if (!(plaintext instanceof Buffer)) {
    throw new DekInvariantError('plaintext must be a Buffer.');
  }

  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  const head = cipher.update(plaintext);
  const tail = cipher.final();
  const ciphertext = Buffer.concat([head, tail]);
  const authTag = cipher.getAuthTag();
  // `createCipheriv` with `aes-256-gcm` produces a 16-byte tag by
  // default, but be defensive in case a node version ever disagrees.
  if (authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new DekInvariantError(
      `Unexpected GCM tag size ${authTag.length}; expected ${GCM_AUTH_TAG_BYTES}.`,
    );
  }
  return { ciphertext, nonce, authTag };
}

/**
 * Decrypt a {@link DekCiphertext} with `dek`.
 *
 * Throws {@link DekInvariantError} on shape violations and the native
 * crypto error on GCM authentication failure (which upstream layers
 * classify as `internal` — a tampered ciphertext at the DB layer is
 * never a user-recoverable error).
 */
export function decryptWithDek(env: DekCiphertext, dek: Buffer): Buffer {
  assertDek(dek);
  if (
    !(env.ciphertext instanceof Buffer) ||
    !(env.nonce instanceof Buffer) ||
    !(env.authTag instanceof Buffer)
  ) {
    throw new DekInvariantError('DekCiphertext fields must all be Buffers.');
  }
  if (env.nonce.length !== GCM_NONCE_BYTES) {
    throw new DekInvariantError(
      `nonce must be ${GCM_NONCE_BYTES} bytes (got ${env.nonce.length}).`,
    );
  }
  if (env.authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new DekInvariantError(
      `authTag must be ${GCM_AUTH_TAG_BYTES} bytes (got ${env.authTag.length}).`,
    );
  }

  const decipher = createDecipheriv('aes-256-gcm', dek, env.nonce);
  decipher.setAuthTag(env.authTag);
  const head = decipher.update(env.ciphertext);
  const tail = decipher.final();
  return Buffer.concat([head, tail]);
}

/**
 * Overwrite `buf` with zeros in place. Used on DEK eviction,
 * user-key-plaintext disposal and error paths. §2 invariant 1 and §5.1
 * step 8 both hinge on this function being called wherever a key
 * touched memory.
 *
 * Node's `Buffer` API is stable enough here: the actual backing store
 * is a `Uint8Array`, and `fill(0)` writes zeros synchronously without
 * allocation. We still handle non-Buffer inputs defensively so tests
 * that pass typed arrays don't silently no-op.
 */
export function zeroize(buf: Buffer | Uint8Array | null | undefined): void {
  if (buf === null || buf === undefined) return;
  if (buf instanceof Buffer) {
    buf.fill(0);
    return;
  }
  if (buf instanceof Uint8Array) {
    buf.fill(0);
    return;
  }
}
