import express, { Request, Response, NextFunction } from 'express';
import { WhitelistManager } from './whitelist.js';

const app = express();
const port = process.env.PORT ?? 3000;
const beeApiUrl = process.env.BEE_API_URL ?? 'http://localhost:1633';
const whitelistPath = process.env.WHITELIST_PATH ?? '/data/whitelist.json';

const whitelist = new WhitelistManager(whitelistPath);

app.use(express.json());

// Logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', whitelistSize: whitelist.count() });
});

/**
 * Proxy endpoint for accessing Swarm content
 * Only allows access to whitelisted hashes
 * Handles both /bzz/:hash and /bzz/:hash/subpath/...
 */
app.use('/bzz/:hash', async (req: Request, res: Response) => {
  const hash = req.params.hash;
  // Extract the subpath by removing /bzz/:hash from the full path
  const fullPath = req.path;
  const subpath = fullPath.substring(hash.length + 1); // +1 for the leading slash

  if (!whitelist.isWhitelisted(hash)) {
    console.warn(`Blocked access to non-whitelisted hash: ${hash}`);
    res.status(403).json({
      error: 'Access denied',
      message: 'This hash is not whitelisted'
    });
    return;
  }

  try {
    // Build URL with subpath if present
    const url = subpath
      ? `${beeApiUrl}/bzz/${hash}/${subpath}`
      : `${beeApiUrl}/bzz/${hash}`;
    console.log(`Proxying request to: ${url}`);

    const response = await fetch(url);

    // Copy headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value));
        await pump();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying request:', error);
    res.status(502).json({
      error: 'Bad gateway',
      message: 'Failed to fetch content from bee node'
    });
  }
});

// Admin API endpoints

/**
 * Get all whitelisted hashes
 */
app.get('/admin/whitelist', (_req: Request, res: Response) => {
  res.json({
    hashes: whitelist.getAll(),
    count: whitelist.count()
  });
});

/**
 * Add a hash to the whitelist
 */
app.post('/admin/whitelist', async (req: Request, res: Response) => {
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
app.delete('/admin/whitelist/:hash', async (req: Request, res: Response) => {
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
app.delete('/admin/whitelist', async (_req: Request, res: Response) => {
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
    app.listen(port, () => {
      console.log(`Bee Gateway Proxy listening on port ${port}`);
      console.log(`Proxying to Bee API at: ${beeApiUrl}`);
      console.log(`Whitelist size: ${whitelist.count()}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
