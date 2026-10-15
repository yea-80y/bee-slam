import type { NextFunction, Request, Response } from 'express';

// A failed answer must never be cached. Bee sends no Cache-Control, so Cloudflare
// stamped its 4 h browser TTL on 404s too, and a device that asked for a file while
// its postage batch was dead kept "not found" for hours after the file was back
// (WoCo #859, 2026-10-12 and 2026-10-15). Hooked at writeHead, the one place every
// response passes - res.json, res.send, a piped Bee body and Node's implicit header -
// so no route can forget it, and it overrides whatever an upstream header said.
export function noStoreOnErrors(_req: Request, res: Response, next: NextFunction): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, statusCode: number, ...rest: unknown[]) {
    if (statusCode >= 400) {
      this.setHeader('Cache-Control', 'no-store');
      for (const arg of rest) dropCacheControl(arg);
    }
    return (writeHead as (...a: unknown[]) => Response).call(this, statusCode, ...rest);
  } as typeof res.writeHead;
  next();
}

// writeHead's own header argument wins over setHeader, so a Cache-Control passed
// there would undo the line above. Both shapes Node accepts: an object, a flat array.
function dropCacheControl(headers: unknown): void {
  if (Array.isArray(headers)) {
    for (let i = headers.length - 2; i >= 0; i -= 2) {
      if (String(headers[i]).toLowerCase() === 'cache-control') headers.splice(i, 2);
    }
  } else if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'cache-control') delete (headers as Record<string, unknown>)[key];
    }
  }
}
