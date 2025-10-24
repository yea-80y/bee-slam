# Bee SLAM - Secure List Access Manager

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![GitHub Stars](https://img.shields.io/github/stars/mfw78/bee-slam?style=social)](https://github.com/mfw78/bee-slam/stargazers)
[![Docker](https://img.shields.io/badge/docker-compose-blue)](https://docs.docker.com/compose/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)

A Docker-based setup for running an ultra-light Bee node with a TypeScript proxy that provides hash-based access control to Ethereum Swarm content.

## What is Bee?

Bee is a client implementation for the Ethereum Swarm network - a decentralized storage and distribution network. This gateway provides read-only access to whitelisted Swarm content without requiring blockchain interaction or token staking.

## Architecture

### System Overview

The gateway consists of two main components working together:

1. **Bee Ultra-Light Node**: Connects to Swarm network for content retrieval
2. **TypeScript Proxy**: Whitelisting gateway with admin API for access control

```
┌──────────────────────────────────────────────────────────────┐
│                     Docker Network                           │
│                                                              │
│  ┌──────────────────┐              ┌────────────────────┐   │
│  │  Bee Proxy       │              │  Bee Ultra-Light   │   │
│  │  (TypeScript)    │              │  Node              │   │
│  │                  │──Internal──► │                    │   │
│  │  Port 3000       │   Network    │  API: 1633        │   │
│  │  - /bzz/:hash    │              │  P2P: 1634        │───┼──► Swarm Network
│  │  - /admin/*      │              │                    │   │
│  │  - Whitelist DB  │              │  Read-only access  │   │
│  └──────────────────┘              └────────────────────┘   │
│         │                                                    │
└─────────┼────────────────────────────────────────────────────┘
          │
          ▼
    External Access
    (Port 3000 only)
```

### Security Model

- **Bee node** is on an internal Docker network - not directly accessible from the host
- **Proxy** is the only externally accessible component (port 3000)
- All `/bzz/:hash` requests are validated against a persistent whitelist
- Admin API allows dynamic whitelist management while running
- P2P port (1634) remains exposed for Swarm network connectivity

### Node Type: Ultra-Light

The Bee node runs in **ultra-light mode**:

- **Read-only access**: Download files from Swarm
- **No blockchain interaction**: Operates without Gnosis Chain connectivity
- **No payment system**: SWAP protocol disabled (no xBZZ or xDAI needed)
- **No storage commitment**: Does not participate in data storage or retrieval incentives
- **Free tier**: Suitable for simple content access without earning rewards

### Configuration

Key command-line flags in `docker-compose.yml`:

- `--full-node=false`: Runs as a light node (not full node)
- `--swap-enable=false`: Disables SWAP payment protocol
- `--skip-postage-snapshot`: Skips postage stamp contract synchronization
- `--cors-allowed-origins=*`: Allows API access from any origin
- `--api-addr=:1633`: HTTP API listen address
- `--p2p-addr=:1634`: P2P networking listen address

The `--skip-postage-snapshot` flag is crucial for ultra-light nodes, preventing unnecessary blockchain synchronization attempts.

## Getting Started

### Prerequisites

- Docker with Docker Compose
- Port 3000 (proxy) and 1634 (P2P) available

### Setup

1. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env and set a secure password for the Bee node
   ```

2. **Start the services**:
   ```bash
   docker compose up -d
   ```

   This starts both the Bee node and the proxy gateway.

3. **Check proxy health**:
   ```bash
   curl http://localhost:3000/health
   ```

4. **View logs**:
   ```bash
   # Proxy logs
   docker logs -f bee-proxy

   # Bee node logs
   docker logs -f bee-node
   ```

### Stopping the Node

```bash
docker compose down
```

To remove all data (including downloaded content):
```bash
docker compose down -v
```

### Troubleshooting

**Bootnode connection warnings**: It's normal to see warnings like "connect to bootnode failed" in the Bee node logs. The ultra-light node will continue to operate despite these warnings.

**Proxy restarting**: If the proxy container continuously restarts, check:
- The Bee node is running (`docker ps` should show `bee-node`)
- Port 3000 is not already in use

**Bee node restarting**: If the bee-node container continuously restarts, check that:
- The password is set in `.env` file
- Docker has sufficient resources
- Port 1634 is not already in use

**403 Access Denied**: The requested Swarm hash is not in the whitelist. Add it via the admin API.

## API Usage

### Proxy Endpoints

#### Health Check

```bash
curl http://localhost:3000/health
```

#### Access Swarm Content (Whitelisted Only)

```bash
# Access whitelisted content
curl http://localhost:3000/bzz/<swarm-hash>

# Access with subpath
curl http://localhost:3000/bzz/<swarm-hash>/path/to/file.txt
```

### Admin API - Whitelist Management

#### Get All Whitelisted Hashes

```bash
curl http://localhost:3000/admin/whitelist
```

#### Add Single Hash

```bash
curl -X POST http://localhost:3000/admin/whitelist \
  -H "Content-Type: application/json" \
  -d '{"hash":"<64-char-hex-hash>"}'
```

#### Add Multiple Hashes

```bash
curl -X POST http://localhost:3000/admin/whitelist \
  -H "Content-Type: application/json" \
  -d '{"hashes":["<hash1>","<hash2>","<hash3>"]}'
```

#### Remove Hash

```bash
curl -X DELETE http://localhost:3000/admin/whitelist/<hash>
```

#### Clear Entire Whitelist

```bash
curl -X DELETE http://localhost:3000/admin/whitelist
```

### ENS Integration Test

The proxy includes a test script that resolves ENS names to Swarm hashes:

```bash
# From the proxy directory
cd proxy
pnpm test:ens              # Tests woco.eth by default
pnpm test:ens mydomain.eth # Test any ENS name
```

This script:
1. Resolves the ENS name on Ethereum mainnet
2. Extracts the Swarm content hash
3. Adds it to the whitelist
4. Tests accessing the content through the proxy

## Node Types Comparison

| Feature | Ultra-Light | Light | Full |
|---------|-------------|-------|------|
| Download content | ✓ | ✓ | ✓ |
| Upload content | ✗ | ✓ | ✓ |
| Blockchain connection | ✗ | ✓ | ✓ |
| Earn rewards | ✗ | ✗ | ✓ |
| Storage commitment | ✗ | ✗ | ✓ |
| Requires xBZZ/xDAI | ✗ | ✓ | ✓ |

## Limitations

As an ultra-light node:

- **Download only**: Cannot upload new content to Swarm
- **No persistence guarantees**: Does not contribute to long-term data storage
- **Limited functionality**: Access to free-tier services only
- **Network participation**: Minimal - primarily for content retrieval
- **Bootnode connectivity**: May show warnings about bootnode connection failures, but the node will remain operational

## Security Considerations

### Current Protection

✅ **Bee node isolated**: API port (1633) only accessible within Docker network
✅ **Whitelist enforcement**: Only approved hashes can be accessed
✅ **Persistent whitelist**: Survives container restarts
✅ **Admin API**: Dynamic whitelist management

### Recommended for Production

⚠️ **Admin API Protection**: The admin endpoints (`/admin/*`) should be protected:
- Add authentication middleware (API keys, JWT, etc.)
- Restrict to specific IPs via firewall
- Use a reverse proxy with authentication

**Additional Hardening**:
- Use a reverse proxy (nginx, traefik) with TLS termination
- Configure firewall rules to restrict proxy access
- Monitor whitelist changes
- Regular security audits of whitelisted content

## Upgrading

To upgrade to the latest stable version:

```bash
docker compose pull
docker compose up -d
```

## Project Structure

```
bee-gateway/
├── docker-compose.yml          # Multi-container orchestration
├── .env                        # Bee node password (gitignored)
├── .env.example               # Environment template
├── proxy/                     # TypeScript proxy service
│   ├── src/
│   │   ├── index.ts          # Main proxy server
│   │   ├── whitelist.ts      # Whitelist manager with persistence
│   │   └── test-ens.ts       # ENS resolution test script
│   ├── Dockerfile            # Multi-stage build for proxy
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## Resources

- **Bee SLAM Repository**: https://github.com/mfw78/bee-slam
- **Bee Repository**: https://github.com/ethersphere/bee
- **Swarm Documentation**: https://docs.ethswarm.org/
- **Official Website**: https://www.ethswarm.org/
- **Ethers.js Documentation**: https://docs.ethers.org/

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the BSD 3-Clause License - see the [LICENSE](LICENSE) file for details.
