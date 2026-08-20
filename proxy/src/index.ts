import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { gunzipSync } from 'zlib';
import { WhitelistManager } from './whitelist.js';

const app = express();
const port = process.env.PORT ?? 3000;
const beeApiUrl = process.env.BEE_API_URL ?? 'http://localhost:1633';
const whitelistPath = process.env.WHITELIST_PATH ?? '/data/whitelist.json';

const whitelist = new WhitelistManager(whitelistPath);

// Feed owners that are allowed to create new feeds without manual whitelisting.
// Any feed manifest from these owners bypasses the whitelist check automatically.
const ALLOWED_FEED_OWNERS = new Set([
  'f8af4904c6e4f08ce5f7deab7f01221280b23a80' // WoCo main feed owner
]);

// Known feed manifests - when Bee can't resolve these due to missing trie nodes,
// we fall back to querying the feed directly. This is seeded with known manifests
// but dynamically populated as new feed manifests are discovered.
const FEED_MANIFEST_REGISTRY: Record<string, { owner: string; topic: string }> = {
  // WoCo Events App feed manifest (topic: woco-events-v1) — used by woco.eth.limo
  'd66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc': {
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: 'aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2'
  },
  // Gateway feed manifest (topic: woco-website-v2)
  '9ebcea7ca2d4a3a975d1724ee579856684dc6f2ffa3082b64317006c922f3100': {
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: '57d52cda5c8794db2dc1540fde6be327e9d7ea120f8c491eef9f8469e7167568'
  },
  // Legacy feed manifest (topic: woco-website)
  '0b4ea8162a3fcbb19b63705f0c97137eef667d3c3cd4ecf69d686c5f98fb0054': {
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: 'bb6a23bf07aa84a41fe44a485dd811ea10cc57a7cb88257789920813549f81d1'
  },
  // ENS feed manifest (topic: woco-ens-2026)
  'e315d1798ec34cc7137c6b8c79cb28d586d972898fef769cdca08ad13b74d89c': {
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: '20449894e8e4183fc8f0ba08b57e55ca9c0a3d669cab29e1eaf12a4ccc927e0e'
  }
};

// Cache for hashes we've checked that are NOT feed manifests (to avoid repeated checks)
const NOT_FEED_MANIFEST_CACHE = new Set<string>();

// Cache for resolved feed content references (feed manifest hash -> content ref)
const FEED_CONTENT_CACHE: Map<string, { contentRef: string; expires: number }> = new Map();
// Detected/third-party feeds: short TTL so genuine updates are picked up quickly
const FEED_CACHE_TTL = 60 * 1000; // 60s
// Known WoCo registry feeds: long TTL — startup pre-warm + per-deploy refresh handles updates,
// so user requests never pay bee's ~3s cold feed-resolve cost.
const FEED_REGISTRY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function getCachedFeedContent(manifestHash: string): string | null {
  const cached = FEED_CONTENT_CACHE.get(manifestHash);
  if (cached && cached.expires > Date.now()) {
    return cached.contentRef;
  }
  if (cached) {
    FEED_CONTENT_CACHE.delete(manifestHash);
  }
  return null;
}

function cacheFeedContent(manifestHash: string, contentRef: string): void {
  const ttl = manifestHash.toLowerCase() in FEED_MANIFEST_REGISTRY
    ? FEED_REGISTRY_CACHE_TTL
    : FEED_CACHE_TTL;
  FEED_CONTENT_CACHE.set(manifestHash, {
    contentRef,
    expires: Date.now() + ttl
  });
}

// Pre-warm the registry feed cache at startup so the first user after restart
// never pays bee's ~3s cold feed-resolve cost. Fire-and-forget per feed.
async function prewarmRegistryFeeds(): Promise<void> {
  const entries = Object.entries(FEED_MANIFEST_REGISTRY);
  console.log(`Pre-warming feed cache for ${entries.length} registry feeds...`);
  await Promise.all(entries.map(async ([manifestHash, info]) => {
    try {
      const contentRef = await resolveFeed(info.owner, info.topic);
      if (contentRef) {
        cacheFeedContent(manifestHash, contentRef);
        console.log(`  warmed ${manifestHash} -> ${contentRef}`);
      } else {
        console.log(`  WARN: failed to resolve ${manifestHash} during pre-warm`);
      }
    } catch (err) {
      console.log(`  WARN: pre-warm error for ${manifestHash}:`, err);
    }
  }));
}

/**
 * Try to detect feed manifest metadata from the raw bytes of a manifest
 * Feed manifests contain JSON like: {"swarm-feed-owner":"...","swarm-feed-topic":"..."}
 * @param hash - The manifest hash to check
 * @returns Feed info if detected, null otherwise
 */
async function detectFeedManifest(hash: string): Promise<{ owner: string; topic: string } | null> {
  // Skip if already checked and not a feed manifest
  if (NOT_FEED_MANIFEST_CACHE.has(hash)) {
    return null;
  }

  // Already known feed manifest
  if (hash in FEED_MANIFEST_REGISTRY) {
    return FEED_MANIFEST_REGISTRY[hash];
  }

  try {
    console.log(`Attempting to detect feed manifest for: ${hash}`);
    const bytesUrl = `${beeApiUrl}/bytes/${hash}`;
    const response = await fetchWithTimeout(bytesUrl, {}, 5000); // Short timeout

    if (!response.ok) {
      console.log(`Could not fetch bytes for ${hash}: ${response.status}`);
      NOT_FEED_MANIFEST_CACHE.add(hash);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Convert to string and look for feed manifest JSON pattern
    const text = new TextDecoder().decode(bytes);

    // Look for the feed manifest JSON pattern
    const ownerMatch = text.match(/"swarm-feed-owner"\s*:\s*"([a-fA-F0-9]{40})"/);
    const topicMatch = text.match(/"swarm-feed-topic"\s*:\s*"([a-fA-F0-9]{64})"/);

    if (ownerMatch && topicMatch) {
      const feedInfo = {
        owner: ownerMatch[1].toLowerCase(),
        topic: topicMatch[1].toLowerCase()
      };
      console.log(`Detected feed manifest! Owner: ${feedInfo.owner}, Topic: ${feedInfo.topic}`);

      // Cache for future use
      FEED_MANIFEST_REGISTRY[hash] = feedInfo;
      return feedInfo;
    }

    console.log(`Hash ${hash} is not a feed manifest`);
    NOT_FEED_MANIFEST_CACHE.add(hash);
    return null;
  } catch (error) {
    console.error(`Error detecting feed manifest for ${hash}:`, error);
    return null;
  }
}

/**
 * Resolve a feed to get the latest content reference
 * @param owner - Feed owner address (hex)
 * @param topic - Feed topic (hex)
 * @returns The content reference or null if not found
 */
async function resolveFeed(owner: string, topic: string): Promise<string | null> {
  // Bee returns the resolved content reference in the `etag` header on
  // GET /feeds/{owner}/{topic}. This is the canonical, documented field.
  // The body bytes encode the SOC payload (timestamp + reference + padding)
  // whose layout has historically been mis-parsed by hand-sliced offsets.
  try {
    const feedUrl = `${beeApiUrl}/feeds/${owner}/${topic}`;
    const response = await fetchWithTimeout(feedUrl);
    if (!response.ok) {
      console.log(`Feed resolution failed with status: ${response.status}`);
      return null;
    }
    // Drain body so the connection can be reused
    await response.arrayBuffer();
    const etag = response.headers.get('etag')?.replace(/"/g, '') ?? '';
    if (/^[0-9a-f]{64}$/i.test(etag)) {
      return etag.toLowerCase();
    }
    console.log(`Feed resolve: missing or malformed etag header: ${etag}`);
    return null;
  } catch (error) {
    console.error('Feed resolution error:', error);
    return null;
  }
}

// Timeout for fetch requests to bee node (15 seconds)
// This prevents requests from hanging when bee-node is slow/unresponsive
// and ensures we fail gracefully before Cloudflare's 30-second timeout
const BEE_REQUEST_TIMEOUT = 15000;

/**
 * Helper function to create a fetch request with timeout
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param timeout - Timeout in milliseconds (default: 15 seconds)
 * @returns Promise that resolves with Response or rejects on timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = BEE_REQUEST_TIMEOUT
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Request timeout: bee node took longer than ${timeout}ms to respond`);
    }
    throw error;
  }
}

/**
 * Helper function to stream response with timeout protection
 * Wraps each reader.read() call with a timeout to prevent hanging
 * @param reader - ReadableStream reader
 * @param res - Express response object
 * @param timeout - Timeout in milliseconds for each read operation
 */
async function streamWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: Response,
  timeout: number = BEE_REQUEST_TIMEOUT
): Promise<void> {
  while (true) {
    // Race between read() and timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stream read timeout')), timeout);
    });

    try {
      const result = await Promise.race([
        reader.read(),
        timeoutPromise
      ]);

      if (result.done) {
        res.end();
        return;
      }

      res.write(Buffer.from(result.value));
    } catch (error) {
      reader.cancel();
      throw error;
    }
  }
}

// Trust proxy headers (required for Cloudflare Tunnel and rate limiting)
// Trust only the first proxy (Cloudflare Tunnel)
app.set('trust proxy', 1);

// Helper function to check if request is from localhost/local network
function isLocalRequest(req: Request): boolean {
  const raw = req.ip || req.socket.remoteAddress || '';
  // NORMALISE THE IPv4-MAPPED IPv6 FORM FIRST. This listener is dual-stack
  // (`app.listen(port)` binds `:::3000`), so Node presents an IPv4 peer as
  // `::ffff:172.18.0.3`. The localhost arm below was written knowing that —
  // it spells out `::ffff:127.0.0.1` — but the PRIVATE-RANGE arms were not,
  // so `startsWith('172.')` never matched and every in-cluster Docker call
  // read as REMOTE and fell under the rate limiters.
  //
  // Measured 2026-08-20 (WoCo #332): the API server calls this proxy at
  // http://bee-proxy:3000 from 172.18.0.3 and was being rate-limited anyway —
  // `ratelimit-limit: 1000` came back on an in-cluster probe, proving the skip
  // never fired. Its SOC whitelist calls then 429'd against the 50-per-15-min
  // admin cap, ~50 failures in 6 hours, each swallowed by the caller. Freshly
  // written chunks were left unwhitelisted and 403'd on read until a
  // server-fallback read repaired them one at a time.
  const ip = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;

  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  // 172.16.0.0/12 is the actual private block — 172.16.x to 172.31.x. The old
  // bare `startsWith('172.')` also exempted PUBLIC 172.x space (e.g. 172.217.x
  // is Google), which widened the exemption well past the intent. Docker's
  // default bridge pools sit inside 172.16/12, so this still covers the case
  // it exists for.
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

// Rate limiting configuration
// General rate limit - 1000 requests per 1 minute per IP (burst-friendly for browsing)
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000, // Limit each IP to 1000 requests per window
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req: Request) => isLocalRequest(req), // Skip rate limiting for local requests
});

// Upload rate limit - 2000 requests per hour per IP
// Event creation needs: N ticket uploads + metadata + image + feed writes
// A 500-ticket event needs ~510 requests, so 2000 gives comfortable headroom
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 2000,
  message: 'Too many upload requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => isLocalRequest(req), // Skip rate limiting for local requests
});

// Admin endpoint rate limit - 50 requests per 15 minutes per IP
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: 'Too many admin requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => isLocalRequest(req), // Skip rate limiting for local requests
});

// Upload secret — required on all write endpoints for non-local requests.
// Local requests (127.x from SSH tunnel, 172.x from Docker server) are exempt.
// Set UPLOAD_SECRET env var on the server; leave unset for local dev.
const uploadSecret = process.env.UPLOAD_SECRET || '';

function requireUploadSecret(req: Request, res: Response, next: NextFunction): void {
  if (!uploadSecret) { next(); return; } // dev: no secret set, allow all
  if (req.headers['x-upload-secret'] !== uploadSecret) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// CORS middleware - allow all origins (must be BEFORE body parsers)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-upload-secret, swarm-postage-batch-id, swarm-deferred-upload, swarm-redundancy-level, swarm-encrypt, swarm-index-document, swarm-error-document, swarm-collection, swarm-pin, swarm-tag');
  // X-Chunk-Gate must be exposed or a browser cannot read it at all (CORS
  // hides every non-safelisted response header by default).
  res.setHeader('Access-Control-Expose-Headers', 'swarm-tag, etag, X-Chunk-Gate');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Apply general rate limiting to all requests
app.use(generalLimiter);

// Body parsers - order matters!
// For /soc endpoints, we need raw binary data - do NOT apply any global parsers to these routes
// We'll use route-level middleware instead
// For other endpoints
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip body parsing entirely for /soc routes
  if (req.path.startsWith('/soc/')) {
    return next();
  }
  // For non-SOC routes, apply normal parsing
  // Parse JSON bodies
  express.json()(req, res, () => {
    // Parse raw binary for uploads (images, files, etc.)
    // Accept all content types as raw for /bzz and /bytes endpoints
    if (req.path.startsWith('/bzz') || req.path.startsWith('/bytes')) {
      express.raw({ type: '*/*', limit: '50mb' })(req, res, next);
    } else {
      // For other endpoints, parse specific types
      express.raw({ type: 'application/octet-stream', limit: '50mb' })(req, res, () => {
        express.text({ type: 'text/plain', limit: '50mb' })(req, res, next);
      });
    }
  });
});

// Logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const isLocal = isLocalRequest(req);
  const logMessage = `${timestamp} - ${req.method} ${req.path} [ip=${ip} local=${isLocal}]`;
  console.log(logMessage);
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', whitelistSize: whitelist.count() });
});

/**
 * Get postage stamps from bee node
 */
app.get('/stamps', async (_req: Request, res: Response) => {
  try {
    const response = await fetchWithTimeout(`${beeApiUrl}/stamps`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching stamps:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: 'Failed to fetch stamps',
      message: (error as Error).message
    });
  }
});

/**
 * Buy a new postage stamp
 * POST /stamps/:amount/:depth
 */
app.post('/stamps/:amount/:depth', requireUploadSecret, adminLimiter, async (req: Request, res: Response) => {
  const { amount, depth } = req.params;

  try {
    console.log(`Buying postage stamp: amount=${amount}, depth=${depth}`);

    const response = await fetchWithTimeout(`${beeApiUrl}/stamps/${amount}/${depth}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, 120000); // 120 seconds for blockchain operation

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Stamp purchase failed:', errorText);
      res.status(response.status).json({
        error: 'Stamp purchase failed',
        message: errorText
      });
      return;
    }

    const data = await response.json() as { batchID: string };
    console.log(`Stamp purchased successfully: ${data.batchID}`);
    res.json(data);
  } catch (error) {
    console.error('Error buying stamp:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 500;
    res.status(statusCode).json({
      error: 'Failed to buy stamp',
      message: (error as Error).message
    });
  }
});

/**
 * Top up a postage batch
 */
app.patch('/stamps/topup/:batchId/:amount', requireUploadSecret, adminLimiter, async (req: Request, res: Response) => {
  const { batchId, amount } = req.params;

  try {
    console.log(`Topping up batch ${batchId} with ${amount}`);

    const response = await fetchWithTimeout(`${beeApiUrl}/stamps/topup/${batchId}/${amount}`, {
      method: 'PATCH'
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Topup failed:', errorText);
      res.status(response.status).json({
        error: 'Topup failed',
        message: errorText
      });
      return;
    }

    const data = await response.json();
    console.log(`Batch ${batchId} topped up successfully`);
    res.json(data);
  } catch (error) {
    console.error('Error topping up batch:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: 'Failed to top up batch',
      message: (error as Error).message
    });
  }
});

/**
 * Dilute a postage batch (increase depth to allow more storage)
 * PATCH /stamps/dilute/:batchId/:depth
 * Note: Dilution is irreversible and halves TTL for each depth increase
 */
app.patch('/stamps/dilute/:batchId/:depth', requireUploadSecret, adminLimiter, async (req: Request, res: Response) => {
  const { batchId, depth } = req.params;

  try {
    console.log(`Diluting batch ${batchId} to depth ${depth}`);

    const response = await fetchWithTimeout(`${beeApiUrl}/stamps/dilute/${batchId}/${depth}`, {
      method: 'PATCH'
    }, 120000); // 120 seconds for blockchain operation

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Dilution failed:', errorText);
      res.status(response.status).json({
        error: 'Dilution failed',
        message: errorText
      });
      return;
    }

    const data = await response.json();
    console.log(`Batch ${batchId} diluted to depth ${depth} successfully`);
    res.json(data);
  } catch (error) {
    console.error('Error diluting batch:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: 'Failed to dilute batch',
      message: (error as Error).message
    });
  }
});

/**
 * Upload endpoint for posting content to Swarm
 * Automatically whitelists the returned hash
 */
app.post('/bzz', requireUploadSecret, uploadLimiter, async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    const swarmPostageBatchId = req.headers['swarm-postage-batch-id'] as string;

    console.log(`BZZ POST - Content-Type: ${contentType}`);
    console.log(`BZZ POST - Body type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}`);
    console.log(`BZZ POST - Body length: ${Buffer.isBuffer(req.body) ? req.body.length : 'N/A'}`);

    if (!swarmPostageBatchId) {
      res.status(400).json({
        error: 'Bad request',
        message: 'swarm-postage-batch-id header is required'
      });
      return;
    }

    console.log(`Uploading content with batch ID: ${swarmPostageBatchId}`);

    // Extract query string for bee node (includes name, index document params, etc.)
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const beeUrl = `${beeApiUrl}/bzz${queryString}`;
    console.log(`Forwarding to: ${beeUrl}`);

    // Forward the upload to bee node
    // Build headers - forward all swarm-* headers from bee-js
    const forwardHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'swarm-postage-batch-id': swarmPostageBatchId,
    };

    // Forward website-specific headers (from bee-js source: src/utils/headers.ts)
    // Check both lowercase and capitalized versions
    const swarmHeaders = [
      { incoming: 'swarm-index-document', outgoing: 'swarm-index-document' },
      { incoming: 'swarm-error-document', outgoing: 'swarm-error-document' },
      { incoming: 'swarm-collection', outgoing: 'swarm-collection' },
      { incoming: 'swarm-redundancy-level', outgoing: 'swarm-redundancy-level' },
      { incoming: 'swarm-encrypt', outgoing: 'swarm-encrypt' },
      { incoming: 'swarm-deferred-upload', outgoing: 'swarm-deferred-upload' },
      { incoming: 'swarm-pin', outgoing: 'swarm-pin' },
      { incoming: 'swarm-tag', outgoing: 'swarm-tag' }
    ];
    for (const { incoming, outgoing } of swarmHeaders) {
      const value = req.headers[incoming] || req.headers[incoming.toLowerCase()];
      if (value) {
        forwardHeaders[outgoing] = String(value);
        console.log(`Forwarding header: ${outgoing} = ${value}`);
      }
    }

    const uploadResponse = await fetchWithTimeout(beeUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: req.body as Buffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Upload failed:', errorText);
      res.status(uploadResponse.status).json({
        error: 'Upload failed',
        message: errorText
      });
      return;
    }

    const result = await uploadResponse.json() as { reference: string };
    const hash = result.reference;

    // Automatically whitelist the uploaded hash
    await whitelist.add(hash);
    console.log(`Content uploaded and whitelisted: ${hash}`);

    res.json({
      success: true,
      reference: hash,
      message: 'Content uploaded and automatically whitelisted'
    });
  } catch (error) {
    console.error('Error uploading content:', error);
    res.status(500).json({
      error: 'Upload failed',
      message: (error as Error).message
    });
  }
});

/**
 * POST /bytes endpoint for uploading raw bytes
 * Automatically whitelists the returned hash
 */
app.post('/bytes', requireUploadSecret, uploadLimiter, async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    const swarmPostageBatchId = req.headers['swarm-postage-batch-id'] as string;

    if (!swarmPostageBatchId) {
      res.status(400).json({
        error: 'Bad request',
        message: 'swarm-postage-batch-id header is required'
      });
      return;
    }

    console.log(`Uploading bytes with batch ID: ${swarmPostageBatchId}`);

    const bytesForwardHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'swarm-postage-batch-id': swarmPostageBatchId,
    };
    const bytesPassthrough = [
      'swarm-redundancy-level',
      'swarm-encrypt',
      'swarm-deferred-upload',
      'swarm-pin',
      'swarm-tag',
    ];
    for (const h of bytesPassthrough) {
      const v = req.headers[h] || req.headers[h.toLowerCase()];
      if (v) {
        bytesForwardHeaders[h] = String(v);
        console.log(`Forwarding header: ${h} = ${v}`);
      }
    }

    const uploadResponse = await fetchWithTimeout(`${beeApiUrl}/bytes`, {
      method: 'POST',
      headers: bytesForwardHeaders,
      body: req.body as Buffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Upload failed:', errorText);
      res.status(uploadResponse.status).json({
        error: 'Upload failed',
        message: errorText
      });
      return;
    }

    const result = await uploadResponse.json() as { reference: string };
    const hash = result.reference;

    // Automatically whitelist the uploaded hash
    await whitelist.add(hash);
    console.log(`Bytes uploaded and whitelisted: ${hash}`);

    res.json({
      success: true,
      reference: hash,
      message: 'Bytes uploaded and automatically whitelisted'
    });
  } catch (error) {
    console.error('Error uploading bytes:', error);
    res.status(500).json({
      error: 'Upload failed',
      message: (error as Error).message
    });
  }
});

/**
 * Check if a hash should be allowed access (whitelist OR known/detected feed manifest)
 *
 * Priority order (fast paths first):
 * 1. Whitelist check (instant)
 * 2. Known feed manifest in registry + allowed owner (instant)
 * 3. Auto-detect feed manifest + allowed owner (one-time network request, then cached)
 */
async function isHashAllowed(
  hash: string,
  opts: { detectManifests?: boolean } = {},
): Promise<boolean> {
  const normalizedHash = hash.toLowerCase();

  // Fast path 1: Check whitelist
  if (whitelist.isWhitelisted(normalizedHash)) {
    return true;
  }

  // Fast path 2: Check if it's a known feed manifest from an allowed owner
  const knownFeedInfo = FEED_MANIFEST_REGISTRY[normalizedHash];
  if (knownFeedInfo && ALLOWED_FEED_OWNERS.has(knownFeedInfo.owner.toLowerCase())) {
    console.log(`Feed manifest ${hash} allowed via registry + ALLOWED_FEED_OWNERS`);
    return true;
  }

  // OPT-OUT for callers that can never be asking about a feed manifest. The
  // detection below is a full bee lookup, and on the SOC version-probe path it
  // runs against a stream of never-seen addresses — so the caller pays seconds
  // to be told "no" about something it never asked. See the /chunks call site.
  if (opts.detectManifests === false) {
    return false;
  }

  // Slow path: Try to detect if this is a feed manifest from an allowed owner
  // This only happens once per unknown hash - result is cached in registry or NOT_FEED_MANIFEST_CACHE
  const detectedFeedInfo = await detectFeedManifest(normalizedHash);
  if (detectedFeedInfo && ALLOWED_FEED_OWNERS.has(detectedFeedInfo.owner.toLowerCase())) {
    console.log(`Feed manifest ${hash} auto-detected and allowed - owner ${detectedFeedInfo.owner} is in ALLOWED_FEED_OWNERS`);
    return true;
  }

  return false;
}

/**
 * GET /bytes/:hash endpoint for retrieving raw bytes
 * Only allows access to whitelisted hashes
 */
app.get('/bytes/:hash', async (req: Request, res: Response) => {
  const hash = req.params.hash;

  if (!(await isHashAllowed(hash))) {
    console.warn(`Blocked access to non-whitelisted hash: ${hash}`);
    res.status(403).json({
      error: 'Access denied',
      message: 'This hash is not whitelisted'
    });
    return;
  }

  try {
    const url = `${beeApiUrl}/bytes/${hash}`;
    console.log(`Proxying request to: ${url}`);

    const response = await fetchWithTimeout(url);

    // Copy headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      await streamWithTimeout(reader, res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying /bytes request:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Bad gateway',
      message: (error as Error).message
    });
  }
});

/**
 * GET /chunks/:hash — raw chunk passthrough.
 *
 * Needed by the WoCo server when writing site-pointer feeds in modern
 * (inline) SOC form: it fetches the just-uploaded root manifest's raw
 * chunk bytes and embeds them as the SOC payload, so anonymous /bzz
 * resolution works on Beehive (Etherna) which dropped legacy SOC support.
 *
 * Whitelist-gated like /bytes — only chunks of already-public hashes are
 * served. Internal caller (events-api) hits this immediately after a /bzz
 * upload that auto-whitelisted the hash.
 */
app.get('/chunks/:hash', async (req: Request, res: Response) => {
  const hash = req.params.hash;

  if (!(await isHashAllowed(hash, { detectManifests: false }))) {
    // detectManifests:false — a /chunks request is a raw chunk read, and the
    // WoCo client uses it only for SOCs, whose address is keccak(identifier||owner)
    // and can never be a feed manifest. Running the manifest probe here cost a
    // full bee lookup per never-seen address: measured 2026-08-20 at ~2.76s for a
    // novel hash and ~0.15s once NOT_FEED_MANIFEST_CACHE had it. The SOC version
    // scan asks about novel addresses constantly, so that slow path was on the
    // hot path of every read. Known manifests still resolve here via the registry
    // fast path above, which is a dictionary lookup with no network.
    console.warn(`Blocked access to non-whitelisted chunk: ${hash}`);
    // SELF-IDENTIFYING DENIAL. A bare 403 is ambiguous — Cloudflare, a WAF, or
    // any intermediary can produce one — so a client must never read "403" as
    // "this chunk does not exist". Tagging OUR gate lets a reader distinguish
    // "the gate refused, and the gate is authoritative about what exists here"
    // from "somebody upstream said no", and only trust the former. The header
    // is for well-behaved clients; the body `code` is what survives libraries
    // that surface an error body but not headers.
    res.setHeader('X-Chunk-Gate', 'not-whitelisted');
    res.status(403).json({
      error: 'Access denied',
      code: 'NOT_WHITELISTED',
      message: 'This hash is not whitelisted'
    });
    return;
  }

  try {
    const url = `${beeApiUrl}/chunks/${hash}`;
    const response = await fetchWithTimeout(url);

    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      await streamWithTimeout(reader, res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying /chunks request:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Bad gateway',
      message: (error as Error).message
    });
  }
});

/**
 * GET /feeds/:owner/:topic endpoint for reading Swarm feeds
 * Feeds are public and don't require whitelisting
 * They are used to retrieve feed updates which contain references to actual content
 */
app.get('/feeds/:owner/:topic', async (req: Request, res: Response) => {
  const { owner, topic } = req.params;

  try {
    // Forward query parameters (like ?type=sequence)
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const url = `${beeApiUrl}/feeds/${owner}/${topic}${queryString}`;
    console.log(`Proxying feed request to: ${url}`);

    const response = await fetchWithTimeout(url);

    // Copy headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      await streamWithTimeout(reader, res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying feed request:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Bad gateway',
      message: (error as Error).message
    });
  }
});

/**
 * POST /feeds endpoint for creating feed manifests
 * Creates a manifest that always resolves to the latest feed update
 * Used for ENS and other permanent addressing scenarios
 */
app.post('/feeds', requireUploadSecret, uploadLimiter, async (req: Request, res: Response) => {
  try {
    const swarmPostageBatchId = req.headers['swarm-postage-batch-id'] as string;

    if (!swarmPostageBatchId) {
      res.status(400).json({
        error: 'Bad request',
        message: 'swarm-postage-batch-id header is required'
      });
      return;
    }

    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const url = `${beeApiUrl}/feeds${queryString}`;
    console.log(`Creating feed manifest: ${url}`);

    // Forward all relevant headers
    const headers: Record<string, string> = {
      'swarm-postage-batch-id': swarmPostageBatchId,
    };

    // Copy other Swarm-related headers if present
    const relevantHeaders = ['content-type', 'swarm-pin', 'swarm-tag'];
    relevantHeaders.forEach(headerName => {
      const value = req.headers[headerName];
      if (value) {
        headers[headerName] = Array.isArray(value) ? value[0] : value;
      }
    });

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: req.body as Buffer
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Feed manifest creation failed:', errorText);
      res.status(response.status).json({
        error: 'Feed manifest creation failed',
        message: errorText
      });
      return;
    }

    const result = await response.json() as { reference: string };
    const manifestRef = result.reference;

    // Auto-whitelist the feed manifest reference
    await whitelist.add(manifestRef);
    console.log(`Feed manifest created and whitelisted: ${manifestRef}`);

    res.json({
      success: true,
      reference: manifestRef,
      message: 'Feed manifest created and automatically whitelisted'
    });
  } catch (error) {
    console.error('Error creating feed manifest:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 500;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Feed manifest creation failed',
      message: (error as Error).message
    });
  }
});

/**
 * POST /feeds/:owner/:topic endpoint for updating Swarm feeds
 * This allows users to update their own feeds
 */
app.post('/feeds/:owner/:topic', requireUploadSecret, uploadLimiter, async (req: Request, res: Response) => {
  const { owner, topic } = req.params;

  try {
    const swarmPostageBatchId = req.headers['swarm-postage-batch-id'] as string;

    if (!swarmPostageBatchId) {
      res.status(400).json({
        error: 'Bad request',
        message: 'swarm-postage-batch-id header is required'
      });
      return;
    }

    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const url = `${beeApiUrl}/feeds/${owner}/${topic}${queryString}`;
    console.log(`Proxying feed update to: ${url}`);

    // Forward all relevant headers
    const headers: Record<string, string> = {
      'swarm-postage-batch-id': swarmPostageBatchId,
    };

    // Copy other Swarm-related headers if present
    const relevantHeaders = ['content-type', 'swarm-pin', 'swarm-tag', 'swarm-deferred-upload'];
    relevantHeaders.forEach(headerName => {
      const value = req.headers[headerName];
      if (value) {
        headers[headerName] = Array.isArray(value) ? value[0] : value;
      }
    });

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: req.body as Buffer
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Feed request failed with status ${response.status}:`, errorText);
      console.error(`Request URL: ${url}`);
      console.error(`Request headers:`, headers);
      res.status(response.status).json({
        error: 'Feed update failed',
        message: errorText
      });
      return;
    }

    // For feed updates, read as buffer
    let responseBuffer = Buffer.from(await response.arrayBuffer());

    // Debug logging
    console.log('Feed response - headers:', JSON.stringify([...response.headers.entries()]));
    console.log('Feed response - buffer length:', responseBuffer.length);
    console.log('Feed response - first 100 bytes:', responseBuffer.subarray(0, 100).toString('utf8'));
    console.log('Feed response - first 10 hex:', responseBuffer.subarray(0, 10).toString('hex'));

    // Check if gzip-encoded - check both header AND magic bytes (0x1f 0x8b)
    const isGzipHeader = response.headers.get('content-encoding') === 'gzip';
    const isGzipData = responseBuffer.length >= 2 && responseBuffer[0] === 0x1f && responseBuffer[1] === 0x8b;

    console.log('Feed response - isGzipHeader:', isGzipHeader, ', isGzipData:', isGzipData);

    if (isGzipHeader && isGzipData) {
      try {
        responseBuffer = gunzipSync(responseBuffer);
        console.log('Decompressed gzip feed response, new length:', responseBuffer.length);
      } catch (e) {
        console.error('Failed to decompress gzip feed response:', e);
      }
    } else if (isGzipHeader && !isGzipData) {
      console.log('Header says gzip but data is not gzip-encoded, skipping decompression');
    }

    // Set content-type explicitly as JSON
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', responseBuffer.length.toString());
    res.status(response.status).send(responseBuffer);
    console.log('Feed response sent to client, length:', responseBuffer.length);
  } catch (error) {
    console.error('Error updating feed:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 500;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Feed update failed',
      message: (error as Error).message
    });
  }
});

/**
 * POST /soc/:owner/:id - Single Owner Chunk endpoint
 * Used for feed updates (forum posts, profiles, etc.)
 * Public access - no whitelist check needed for writing
 */
app.post('/soc/:owner/:id',
  requireUploadSecret,
  uploadLimiter,
  express.raw({ type: '*/*', limit: '50mb' }), // Route-level raw body parser
  async (req: Request, res: Response) => {
    const { owner, id } = req.params;

    try {
      const contentType = req.headers['content-type'] ?? 'application/octet-stream';
      const swarmPostageBatchId = req.headers['swarm-postage-batch-id'] as string;

      if (!swarmPostageBatchId) {
        res.status(400).json({
          error: 'Bad request',
          message: 'swarm-postage-batch-id header is required'
        });
        return;
      }

      // Extract query string (includes sig parameter required by Bee)
      // Try multiple sources to get the full URL with query params
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      const originalUrl = (req as any).originalUrl || req.url;

      // Debug logging
      console.log(`SOC POST - req.url: ${req.url}`);
      console.log(`SOC POST - req.originalUrl: ${originalUrl}`);
      console.log(`SOC POST - Content-Type: ${contentType}`);
      console.log(`SOC POST - Query string: ${queryString}`);
      console.log(`SOC POST - All headers:`, JSON.stringify(req.headers, null, 2));
      console.log(`SOC POST - Body type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}`);
      console.log(`SOC POST - Body length: ${Buffer.isBuffer(req.body) ? req.body.length : 'N/A'}`);
      if (Buffer.isBuffer(req.body) && req.body.length < 200) {
        console.log(`SOC POST - Body hex: ${req.body.toString('hex')}`);
      }
      console.log(`Proxying SOC POST to: ${beeApiUrl}/soc/${owner}/${id}${queryString}`);

      const response = await fetchWithTimeout(`${beeApiUrl}/soc/${owner}/${id}${queryString}`, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'swarm-postage-batch-id': swarmPostageBatchId,
        },
        body: req.body as Buffer
      });

      console.log(`Bee response status: ${response.status}`);
      console.log(`Bee response headers:`, JSON.stringify([...response.headers.entries()], null, 2));

      // If error, send error response
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Bee error response: ${errorText}`);
        res.status(response.status).send(errorText);
        return;
      }

      // For successful responses, read the body as buffer and decompress if gzip-encoded
      let responseBuffer = Buffer.from(await response.arrayBuffer());

      // Decompress if gzip-encoded - check both header AND magic bytes (0x1f 0x8b)
      const isGzipHeader = response.headers.get('content-encoding') === 'gzip';
      const isGzipData = responseBuffer.length >= 2 && responseBuffer[0] === 0x1f && responseBuffer[1] === 0x8b;

      if (isGzipHeader && isGzipData) {
        try {
          responseBuffer = gunzipSync(responseBuffer);
          console.log('Decompressed gzip SOC response');
        } catch (e) {
          console.error('Failed to decompress gzip SOC response:', e);
        }
      } else if (isGzipHeader && !isGzipData) {
        console.log('Header says gzip but data is not gzip-encoded, skipping decompression');
      }
      console.log(`Bee response body length: ${responseBuffer.length} bytes`);

      // Auto-whitelist any content references in the SOC body
      // SOC body format: <span (8 bytes)><payload>
      // We need to extract and parse the payload to find imageRef/avatarRef
      if (Buffer.isBuffer(req.body) && req.body.length > 8) {
        try {
          // Skip the first 8 bytes (span) and parse the JSON payload
          const payloadStart = 8;
          const payloadBytes = req.body.subarray(payloadStart);
          const payloadText = payloadBytes.toString('utf8');
          const payload = JSON.parse(payloadText);

          // Check for image references (profile avatars, forum attachments, etc.)
          const imageRef = payload.imageRef || payload.avatarRef;
          if (imageRef && typeof imageRef === 'string' && /^[0-9a-f]{64}$/i.test(imageRef)) {
            await whitelist.add(imageRef);
            console.log(`Auto-whitelisted imageRef from SOC: ${imageRef}`);
          }
        } catch (e) {
          // If parsing fails, just continue - not all SOC uploads contain refs
          console.log('Could not parse SOC payload for auto-whitelisting (this is ok)');
        }
      }

      // Copy headers from Bee response, but skip content-encoding and content-length
      // since we may have decompressed the data
      response.headers.forEach((value, key) => {
        // Don't copy content-encoding or content-length as we're sending decompressed data
        if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
          res.setHeader(key, value);
        }
      });

      // Set correct content-length for the actual buffer we're sending
      res.setHeader('content-length', responseBuffer.length.toString());

      // Send success response with the buffer
      res.status(response.status).send(responseBuffer);
    } catch (error) {
      console.error('Error proxying SOC request:', error);
      res.status(500).json({
        error: 'SOC upload failed',
        message: (error as Error).message
      });
    }
  }
);

/**
 * Proxy endpoint for accessing Swarm content
 * Only allows access to whitelisted hashes
 * Handles both /bzz/:hash and /bzz/:hash/subpath/...
 */
app.use('/bzz/:hash', async (req: Request, res: Response) => {
  const hash = req.params.hash;
  // Extract the subpath by removing /bzz/:hash from the full path
  // Use req.originalUrl to get the complete path
  const hashIndex = req.originalUrl.indexOf(hash);
  const subpath = hashIndex >= 0 ? req.originalUrl.substring(hashIndex + hash.length + 1).split("?")[0] : ""; // +1 for the leading slash
  console.log("DEBUG: req.originalUrl =", req.originalUrl);
  console.log("DEBUG: hash =", hash);
  console.log("DEBUG: subpath =", subpath);

  if (!(await isHashAllowed(hash))) {
    console.warn(`Blocked access to non-whitelisted hash: ${hash}`);
    res.status(403).json({
      error: 'Access denied',
      message: 'This hash is not whitelisted'
    });
    return;
  }

  try {
    // Fast path: check if we have a cached feed content reference for this hash
    const cachedContentRef = getCachedFeedContent(hash);
    if (cachedContentRef) {
      const proxyUrl = subpath
        ? `${beeApiUrl}/bzz/${cachedContentRef}/${subpath}`
        : `${beeApiUrl}/bzz/${cachedContentRef}/`;
      console.log(`Using cached feed content: ${proxyUrl}`);

      const contentResponse = await fetchWithTimeout(proxyUrl);
      contentResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      res.status(contentResponse.status);

      if (contentResponse.body) {
        const reader = contentResponse.body.getReader();
        await streamWithTimeout(reader, res);
      } else {
        res.end();
      }
      return;
    }

    // Fast path for known registry feed manifests: skip the slow /bzz manifest
    // walk and resolve via /feeds + etag directly. Cache for 60s. The /bzz
    // path on bee can take seconds because manifest trie nodes may need
    // network retrieval on a cold or restarted node; /feeds + content-ref
    // fetch is consistently faster once the content chunks are local.
    const knownFeedInfo = FEED_MANIFEST_REGISTRY[hash.toLowerCase()];
    if (knownFeedInfo && ALLOWED_FEED_OWNERS.has(knownFeedInfo.owner.toLowerCase())) {
      const contentRef = await resolveFeed(knownFeedInfo.owner, knownFeedInfo.topic);
      if (contentRef) {
        cacheFeedContent(hash, contentRef);
        if (!whitelist.isWhitelisted(contentRef)) {
          await whitelist.add(contentRef);
        }
        const proxyUrl = subpath
          ? `${beeApiUrl}/bzz/${contentRef}/${subpath}`
          : `${beeApiUrl}/bzz/${contentRef}/`;
        console.log(`Registry fast-path: ${hash} -> ${contentRef} (${proxyUrl})`);

        const contentResponse = await fetchWithTimeout(proxyUrl);
        contentResponse.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.status(contentResponse.status);
        if (contentResponse.body) {
          const reader = contentResponse.body.getReader();
          await streamWithTimeout(reader, res);
        } else {
          res.end();
        }
        return;
      }
      // Resolution failed — fall through to legacy /bzz path
      console.log(`Registry fast-path failed for ${hash}, falling back to /bzz`);
    }

    // Build URL with subpath if present
    const url = subpath
      ? `${beeApiUrl}/bzz/${hash}/${subpath}`
      : `${beeApiUrl}/bzz/${hash}`;
    console.log(`Proxying request to: ${url}`);

    const response = await fetchWithTimeout(url);

    // Check if this is a feed manifest resolution failure
    if (response.status === 404) {
      const bodyText = await response.text();
      // Check for feed-related errors that indicate the manifest trie node is missing
      if (bodyText.includes('no update found') || bodyText.includes('address not found')) {
        // Try to detect if this is a feed manifest (checks registry first, then attempts detection)
        const feedInfo = await detectFeedManifest(hash);

        if (feedInfo) {
          console.log(`Feed manifest ${hash} failed, attempting direct feed resolution...`);
          const contentRef = await resolveFeed(feedInfo.owner, feedInfo.topic);

          if (contentRef) {
            // Cache the resolved content reference for faster subsequent requests
            cacheFeedContent(hash, contentRef);

            // Whitelist the content reference so subpath requests work
            if (!whitelist.isWhitelisted(contentRef)) {
              console.log(`Auto-whitelisting feed content: ${contentRef}`);
              await whitelist.add(contentRef);
            }

            // Proxy directly to the content (don't redirect - keeps feed URL in browser)
            const proxyUrl = subpath
              ? `${beeApiUrl}/bzz/${contentRef}/${subpath}`
              : `${beeApiUrl}/bzz/${contentRef}/`;
            console.log(`Proxying feed content from: ${proxyUrl}`);

            try {
              const contentResponse = await fetchWithTimeout(proxyUrl);

              // Copy headers from content response
              contentResponse.headers.forEach((value, key) => {
                res.setHeader(key, value);
              });

              res.status(contentResponse.status);

              if (contentResponse.body) {
                const reader = contentResponse.body.getReader();
                await streamWithTimeout(reader, res);
              } else {
                res.end();
              }
              return;
            } catch (proxyError) {
              console.error('Error proxying feed content:', proxyError);
              // Fall through to return original error
            }
          }
          console.log('Feed resolution fallback failed, returning original error');
        }
      }
      // Return the original error if fallback didn't work or not a feed manifest
      res.status(404).send(bodyText);
      return;
    }

    // Copy headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      await streamWithTimeout(reader, res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying request:', error);
    const statusCode = (error as Error).message.includes('timeout') ? 504 : 502;
    res.status(statusCode).json({
      error: statusCode === 504 ? 'Gateway timeout' : 'Bad gateway',
      message: (error as Error).message
    });
  }
});

// Admin API endpoints - with strict rate limiting

/**
 * Get all whitelisted hashes
 */
app.get('/admin/whitelist', requireUploadSecret, adminLimiter, (_req: Request, res: Response) => {
  res.json({
    hashes: whitelist.getAll(),
    count: whitelist.count()
  });
});

/**
 * Add a hash to the whitelist
 */
app.post('/admin/whitelist', requireUploadSecret, adminLimiter, async (req: Request, res: Response) => {
  const { hash, hashes } = req.body as { hash?: string; hashes?: string[] };

  try {
    if (hashes && Array.isArray(hashes)) {
      await whitelist.addMany(hashes);
      res.json({
        success: true,
        message: `Added ${hashes.length} hashes to whitelist`,
        count: whitelist.count()
      });
    } else if (hash && typeof hash === 'string') {
      await whitelist.add(hash);
      res.json({
        success: true,
        message: 'Hash added to whitelist',
        hash,
        count: whitelist.count()
      });
    } else {
      res.status(400).json({
        error: 'Bad request',
        message: 'Provide either "hash" (string) or "hashes" (array)'
      });
    }
  } catch (error) {
    res.status(400).json({
      error: 'Invalid hash',
      message: (error as Error).message
    });
  }
});

/**
 * Remove a hash from the whitelist
 */
app.delete('/admin/whitelist/:hash', requireUploadSecret, adminLimiter, async (req: Request, res: Response) => {
  const hash = req.params.hash;

  try {
    await whitelist.remove(hash);
    res.json({
      success: true,
      message: 'Hash removed from whitelist',
      hash,
      count: whitelist.count()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Server error',
      message: (error as Error).message
    });
  }
});

/**
 * Clear the entire whitelist
 */
app.delete('/admin/whitelist', requireUploadSecret, adminLimiter, async (_req: Request, res: Response) => {
  try {
    await whitelist.clear();
    res.json({
      success: true,
      message: 'Whitelist cleared',
      count: 0
    });
  } catch (error) {
    res.status(500).json({
      error: 'Server error',
      message: (error as Error).message
    });
  }
});

// Initialize and start server
async function start(): Promise<void> {
  try {
    await whitelist.initialize();

    // Pre-warm feed cache so first user request after restart hits cache, not bee's ~3s cold path
    await prewarmRegistryFeeds();

    // Wrap app.listen in a Promise to ensure it completes
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port, () => {
        console.log(`Bee Gateway Proxy listening on port ${port}`);
        console.log(`Proxying to Bee API at: ${beeApiUrl}`);
        console.log(`Whitelist size: ${whitelist.count()}`);
        console.log('Rate limiting enabled:');
        console.log('  - General: 1000 req/1min per IP');
        console.log('  - Uploads: 2000 req/1hour per IP');
        console.log('  - Admin: 50 req/15min per IP');
        resolve();
      });

      server.on('error', reject);

      // Keep the process alive and handle shutdown gracefully
      process.on('SIGINT', () => {
        console.log('\nShutting down gracefully...');
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
      });

      process.on('SIGTERM', () => {
        console.log('\nShutting down gracefully...');
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
      });
    });

    // Keep the event loop alive indefinitely
    console.log('Server is now running and will stay alive...');
    setInterval(() => {
      // This keeps the event loop active
    }, 1000 * 60 * 60); // Check every hour (basically forever)
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
