/**
 * Deterministic sharding for KEK-per-shard assignment.
 *
 * Implements the formula from
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §5.1}:
 *
 *   shardId(userId, kekVersion) = hash(userId, kekVersion) mod N(kekVersion)
 *
 * Invariants (§5.1):
 *  - `N(kekVersion)` is **immutable inside a given `kekVersion`**.
 *    Rebalancing changes `N` and therefore requires a new `kekVersion`
 *    (§5.3). Never mutate an entry of {@link SHARD_COUNTS}; add a new
 *    one instead.
 *  - `shardId` is **pure**: same inputs always produce the same output.
 *    No clock, no RNG, no global state.
 *
 * This module is intentionally small. It is imported by the crypto
 * layer, the edge (at BYOK setup) **and** the offline rebalance batch,
 * so it cannot depend on anything heavier than `node:crypto`.
 */

import { createHash } from 'node:crypto';

/**
 * Raised when {@link shardCountFor} is called with a version the
 * package has not declared. This is a *programming error*, not a
 * runtime failure: a row cannot exist under a `kekVersion` that was
 * never provisioned in KMS.
 */
export class UnknownKekVersionError extends Error {
  override readonly name = 'UnknownKekVersionError';
  readonly kekVersion: number;

  constructor(kekVersion: number) {
    super(
      `Unknown kekVersion ${kekVersion}. Register it in ` +
        `packages/llm-client/src/crypto/sharding.ts (SHARD_COUNTS) ` +
        'alongside the KMS alias provisioning and §5.3 rebalance runbook.',
    );
    this.kekVersion = kekVersion;
  }
}

/**
 * Map of `kekVersion` → `N` (shard count). Adding a new entry is the
 * extension point for an §5.3 offline rebalance: the new version
 * coexists with prior ones until every row has been re-wrapped.
 *
 * Rationale for `v1 = 8`:
 *
 *  - Target of §5.1 is ≈1 000 users per shard. 8 shards ⇒ capacity
 *    ~8 000 users with comfortable headroom before the §5.3 trigger of
 *    >2 000 users/shard.
 *  - Power of two keeps `hash mod N` distribution clean and removes
 *    any non-uniform modulo-bias concern on SHA-256 output.
 *  - Keeps KMS fixed cost low at bootstrap (~$8/month for the KEKs)
 *    while amortising the per-user cost to ~$0.001 as traffic grows
 *    (see §5.2 pricing table).
 *
 * Production `N` for a given `kekVersion` is frozen; editing this
 * record in place (without bumping the version) would silently
 * re-route existing users to the wrong KEK and lose access to their
 * stored BYOK keys.
 */
const SHARD_COUNTS: Readonly<Record<number, number>> = Object.freeze({
  1: 8,
});

/**
 * Returns the number of shards configured for the given `kekVersion`.
 *
 * Implemented as a function (not a constant) so that the rebalance
 * runbook (§5.3) can land a new row in {@link SHARD_COUNTS} without
 * any call-site changes: the client, edge and batch jobs all read the
 * same table.
 *
 * @throws {UnknownKekVersionError} if the version is not registered.
 */
export function shardCountFor(kekVersion: number): number {
  if (!Number.isInteger(kekVersion) || kekVersion < 1) {
    throw new UnknownKekVersionError(kekVersion);
  }
  const n = SHARD_COUNTS[kekVersion];
  if (n === undefined) {
    throw new UnknownKekVersionError(kekVersion);
  }
  return n;
}

/**
 * Compute `shardId(userId, kekVersion) = hash(userId, kekVersion) mod N`.
 *
 * Hash: SHA-256 over `utf8(userId) || 0x00 || utf8(String(kekVersion))`.
 *
 *  - The `\x00` separator prevents preimage collisions across
 *    `(userId, kekVersion)` pairs that would otherwise concatenate to
 *    the same byte sequence (e.g. `('a1', 1)` vs `('a', 11)`).
 *  - The full 256-bit digest is read as a BigInt and reduced mod `N`.
 *    This is unbiased for any `N` up to astronomical scales, which
 *    keeps the module correct even when future `kekVersion`s choose a
 *    non-power-of-two shard count.
 *
 * @throws {TypeError} if `userId` is not a non-empty string.
 * @throws {UnknownKekVersionError} if `kekVersion` is not registered.
 */
export function shardId(userId: string, kekVersion: number): number {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('shardId: userId must be a non-empty string.');
  }
  const n = shardCountFor(kekVersion);

  const hash = createHash('sha256');
  hash.update(userId, 'utf8');
  hash.update(Buffer.from([0x00]));
  hash.update(String(kekVersion), 'utf8');
  const digest = hash.digest();

  const value = BigInt('0x' + digest.toString('hex'));
  return Number(value % BigInt(n));
}

/**
 * Exported for tests and for the §5.3 rebalance runbook, which
 * iterates over known versions to emit `llm_kek_shard_distribution`
 * gauges before and after the migration.
 */
export function knownKekVersions(): readonly number[] {
  return Object.keys(SHARD_COUNTS)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
}
