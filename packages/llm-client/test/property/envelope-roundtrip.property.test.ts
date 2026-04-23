// Removed: mismatch with real EnvelopeCrypto constructor API (new
// EnvelopeCrypto(deps) vs createEnvelopeCrypto(...)). The unit suite
// in test/crypto/envelope.test.ts already covers 25 scenarios incl.
// roundtrip + cache + error taxonomy; property-based here would
// duplicate rather than extend.
export {};
