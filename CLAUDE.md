# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Bee Gateway** - a whitelisting proxy for accessing Ethereum Swarm content. The system consists of two services:

1. **Bee ultra-light node** - Connects to Swarm network for read-only content retrieval
2. **TypeScript proxy** - Access control gateway that enforces hash-based whitelisting

The bee node's API (port 1633) is isolated on an internal Docker network and can only be accessed by the proxy. This architecture ensures all Swarm content requests go through whitelist validation.

## Key Architecture Decisions

### Security Model
- **Bee node isolation**: API port 1633 is NOT exposed to the host - only accessible within Docker's internal network (`bee-internal`)
- **Single entry point**: Only the proxy's port 3000 is exposed externally
- **Whitelist enforcement**: All `/bzz/:hash` requests validated against persistent whitelist before proxying to Bee
- **Persistence**: Whitelist stored in `/data/whitelist.json` within Docker volume, survives restarts

### Bee Node Configuration (Critical)
The Bee node runs in **ultra-light mode** which requires specific flags:
- `--full-node=false` - Light node mode
- `--swap-enable=false` - Disables payment protocol (no xBZZ/xDAI needed)
- `--skip-postage-snapshot` - **CRITICAL**: Prevents "chain disabled" errors in v2.6.0+
- `--mainnet=true` - Connects to mainnet bootnodes

Without `--skip-postage-snapshot`, the node attempts blockchain sync even with `swap-enable=false`, causing crash loops.

### TypeScript Proxy Design
- **Strict typing**: All TypeScript with strict mode enabled (`noUnusedLocals`, `noUnusedParameters`, etc.)
- **Express 5**: Uses latest Express with updated routing (no glob wildcards like `*` - use named params)
- **Hash validation**: Only accepts 64-character hex strings (Swarm hash format)
- **Persistence pattern**: `WhitelistManager` handles JSON serialization to Docker volume

## Development Workflow

### Initial Setup
```bash
# Set Bee node password
cp .env.example .env
# Edit .env and set BEE_PASSWORD

# Start both services
docker compose up -d

# Check status
docker ps
curl http://localhost:3000/health
```

### Proxy Development
```bash
cd proxy

# Install dependencies
pnpm install

# Development mode (hot reload)
pnpm dev

# Build TypeScript
pnpm build

# Run compiled code
pnpm start
```

### Testing ENS Integration
```bash
cd proxy

# Test ENS resolution (defaults to woco.eth)
pnpm test:ens

# Test specific ENS name
pnpm test:ens mydomain.eth
```

This script:
1. Resolves ENS name on Ethereum mainnet (via llamarpc)
2. Extracts Swarm hash from content hash (supports both `bzz://` and raw hex formats)
3. Adds hash to whitelist via admin API
4. Tests content retrieval through proxy

### Docker Rebuild After Code Changes
```bash
# Rebuild proxy image
docker compose build proxy

# Recreate proxy container
docker compose up -d proxy

# Or rebuild and restart everything
docker compose up -d --build
```

### Viewing Logs
```bash
# Proxy logs
docker logs -f bee-proxy

# Bee node logs (expect bootnode connection warnings - this is normal)
docker logs -f bee-node

# Both services
docker compose logs -f
```

## API Usage Patterns

### Admin API (Whitelist Management)
```bash
# List all whitelisted hashes
curl http://localhost:3000/admin/whitelist

# Add single hash
curl -X POST http://localhost:3000/admin/whitelist \
  -H "Content-Type: application/json" \
  -d '{"hash":"0e4c03237321d00e46d2607c02033ee991c441c5af891d1a44ced4506fed4d5c"}'

# Add multiple hashes
curl -X POST http://localhost:3000/admin/whitelist \
  -H "Content-Type: application/json" \
  -d '{"hashes":["hash1...","hash2..."]}'

# Remove hash
curl -X DELETE http://localhost:3000/admin/whitelist/<hash>

# Clear entire whitelist
curl -X DELETE http://localhost:3000/admin/whitelist
```

### Content Access (Public API)
```bash
# Access whitelisted content
curl http://localhost:3000/bzz/<hash>

# Access with subpath (for directory-based content)
curl http://localhost:3000/bzz/<hash>/index.html
curl http://localhost:3000/bzz/<hash>/assets/style.css
```

**Important**: Requests return 403 if hash is not whitelisted. Add hash via admin API first.

## Code Organization

```
proxy/
├── src/
│   ├── index.ts       # Express server, routing, admin API
│   ├── whitelist.ts   # WhitelistManager class (persistence logic)
│   └── test-ens.ts    # ENS resolution test script
├── Dockerfile         # Multi-stage build (builder + production)
├── package.json       # pnpm workspace, ESM modules
└── tsconfig.json      # Strict TypeScript config
```

### WhitelistManager (`whitelist.ts`)
Key methods:
- `initialize()` - Loads JSON from disk, call at startup
- `isWhitelisted(hash)` - Query method for request validation
- `add(hash)` / `addMany(hashes)` - Adds and persists atomically
- `remove(hash)` - Removes and persists
- `getAll()` - Returns array of all hashes

Validation: Enforces 64-character hex format via regex: `/^[0-9a-fA-F]{64}$/`

### Proxy Server (`index.ts`)
Route structure:
- `GET /health` - Health check, returns whitelist size
- `GET /admin/whitelist` - List all hashes
- `POST /admin/whitelist` - Add hash(es)
- `DELETE /admin/whitelist/:hash` - Remove specific hash
- `DELETE /admin/whitelist` - Clear all
- `USE /bzz/:hash` - Proxies to Bee node if whitelisted (handles subpaths)

**Routing note**: Express 5 changed wildcard handling. Use `app.use('/bzz/:hash', ...)` instead of `app.get('/bzz/:hash/*', ...)` to handle subpaths. Extract subpath from `req.path`.

### ENS Test Script (`test-ens.ts`)
Uses ethers.js v6 to:
1. Query ENS resolver on mainnet
2. Decode content hash (supports `bzz://` prefix or raw hex with `e40101` codec)
3. Interact with admin API
4. Verify content retrieval

## Common Issues & Solutions

### Bee Node Crash Loop
**Symptom**: `bee-node` container constantly restarting
**Causes**:
1. Missing `--skip-postage-snapshot` flag → node tries blockchain sync with disabled chain
2. Wrong password in `.env` file
3. Port 1634 already in use

**Solution**: Check `docker logs bee-node` for errors. Most common is missing the snapshot flag.

### Proxy 502 Bad Gateway
**Symptom**: Proxy returns 502 when accessing whitelisted hash
**Cause**: Bee node not running or not accessible on internal network
**Solution**:
```bash
docker ps  # Verify bee-node is Up
docker exec bee-proxy ping bee-node  # Test internal DNS
```

### TypeScript Build Errors
**Symptom**: `pnpm build` fails with "unused variable" errors
**Cause**: Strict TypeScript config catches all unused parameters
**Solution**: Prefix unused params with underscore: `_req`, `_res`, `_next`

### Express Routing Errors (PathError)
**Symptom**: Container crashes with "Missing parameter name" in path
**Cause**: Express 5 doesn't support glob syntax like `/bzz/:hash/*`
**Solution**: Use `app.use('/bzz/:hash', ...)` and extract subpath manually from `req.path`

## Environment Variables

### Bee Node (`docker-compose.yml`)
- `BEE_PASSWORD` - Required, set in `.env` file

### Proxy (`docker-compose.yml`)
- `PORT` - Proxy listen port (default: 3000)
- `BEE_API_URL` - Internal URL to Bee node (default: `http://bee-node:1633`)
- `WHITELIST_PATH` - Path to JSON file (default: `/data/whitelist.json`)

### ENS Test Script (`test-ens.ts`)
- `PROXY_URL` - Proxy base URL (default: `http://localhost:3000`)
- `RPC_URL` - Ethereum RPC endpoint (default: `https://eth.llamarpc.com`)

## Important Configuration Files

### `docker-compose.yml`
Defines two-service architecture with internal network. Key points:
- Bee node's port 1633 is NOT in the `ports:` section (internal only)
- Proxy depends on `bee` service
- Shared network `bee-internal` for service communication
- Separate volumes for bee-data and proxy-data

### `proxy/tsconfig.json`
Strict TypeScript configuration:
- `"strict": true` with all granular checks enabled
- `"module": "ESNext"` with `"moduleResolution": "bundler"`
- `"noUnusedLocals"` and `"noUnusedParameters"` enforce clean code

### `proxy/Dockerfile`
Multi-stage build:
1. **Builder**: Installs all deps, runs `pnpm build`
2. **Production**: Installs only prod deps, copies compiled `dist/`

Uses `corepack` to enable pnpm in Alpine Linux.

## Useful Docker Commands

```bash
# Restart specific service
docker compose restart proxy

# Rebuild and restart
docker compose up -d --build proxy

# View internal network
docker network inspect bee-gateway_bee-internal

# Check whitelist persistence
docker exec bee-proxy cat /data/whitelist.json

# Access bee node's internal API (from proxy container)
docker exec bee-proxy curl http://bee-node:1633/health

# Clean slate (removes volumes)
docker compose down -v
```

## Documentation References

- `README.md` - User-facing documentation, API usage, setup instructions
- `SIMPLE_ARCHITECTURE.md` - Non-technical architecture explanation with mermaid diagrams
- Bee docs: https://docs.ethswarm.org/
- Express 5 migration: https://expressjs.com/en/guide/migrating-5.html
