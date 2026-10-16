const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
// Reject bytes at/above this so `% ALPHABET.length` is unbiased (256 % 62 = 8,
// so 248..255 would otherwise over-represent the first 8 symbols). Matters
// because these ids also serve as bearer secrets (webhook secrets, keys).
const MASK = 256 - (256 % ALPHABET.length);

/** Dependency-free nanoid-style id with an unbiased alphabet. Crypto-random. */
export function createId(size = 12): string {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError("createId size must be a positive safe integer");
  }
  // These ids double as bearer secrets (webhook secrets, publishable keys), so
  // never fall back to a non-cryptographic PRNG — fail closed if there's no
  // CSPRNG. Web Crypto is present on Node 18+ and every browser secure context.
  const csprng = globalThis.crypto;
  if (typeof csprng === "undefined" || typeof csprng.getRandomValues !== "function") {
    throw new Error("createId requires Web Crypto (globalThis.crypto.getRandomValues)");
  }
  let id = "";
  while (id.length < size) {
    const bytes = new Uint8Array(size);
    csprng.getRandomValues(bytes);
    for (let i = 0; i < size && id.length < size; i++) {
      const b = bytes[i]!;
      if (b < MASK) id += ALPHABET[b % ALPHABET.length];
    }
  }
  return id;
}
