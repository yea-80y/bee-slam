/**
 * Copy a bee response's headers onto the proxy's response - except bee's CORS
 * headers. The proxy sets its own CORS policy for every request (index.ts), and
 * that is the one browsers must see. Copying bee's verbatim replaced it: bee
 * sends `Access-Control-Expose-Headers: Content-Disposition`, which hid
 * X-Chunk-Gate and the RateLimit headers from every cross-origin reader, so a
 * browser app could neither tell the gate's refusal apart nor pace itself.
 */
export function copyBeeHeaders(
  from: Headers,
  set: (key: string, value: string) => void,
  skip: (lowerKey: string) => boolean = () => false,
): void {
  from.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith('access-control-') || skip(k)) return;
    set(key, value);
  });
}

/**
 * Response headers a cross-origin browser may read. RateLimit-* (draft-6, as
 * express-rate-limit's `standardHeaders: true` sends them) and Retry-After let a
 * client keep inside its allowance instead of finding the limit by hitting it.
 */
export const EXPOSED_HEADERS = [
  'swarm-tag',
  'etag',
  'X-Chunk-Gate',
  'RateLimit-Policy',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
].join(', ');
