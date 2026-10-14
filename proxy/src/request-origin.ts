// The site a request came from - its origin only, never a path - so the logs show
// which front door people use (eth.limo, this gateway, their own Bee node) without
// recording what they looked at. Kept free of express so it can be tested on its own
// (test/request-origin.test.ts).

/**
 * `scheme://host[:port]` from the Origin header, else from the Referer, else "-".
 * WHATWG URL serialisation drops userinfo, path, query and fragment and strips
 * control characters, so nothing a client sends can add a line to the log.
 */
export function requestOrigin(origin: unknown, referer: unknown): string {
  for (const value of [origin, referer]) {
    if (typeof value !== 'string' || value === '' || value === 'null') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin.slice(0, 100);
    } catch {
      // not a URL; try the next header
    }
  }
  return '-';
}
