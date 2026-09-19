// The shared secret that guards every write and admin route, compared in
// constant time. Kept free of express so the comparison can be tested on its
// own (test/upload-secret.test.ts).
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Whether the `x-upload-secret` header carries the expected secret.
 *
 * Both sides are hashed first so the comparison takes the same time whatever
 * the input's length (`timingSafeEqual` throws on unequal lengths, and an
 * early return on a length mismatch would itself leak the length). A header
 * sent twice arrives as an array and is refused, never joined.
 */
export function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || expected === '') return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
