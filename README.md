# Bee Gateway - Ultra-Light Node

This repository contains a Docker-based setup for running an ultra-light Bee node to access the Ethereum Swarm network.

## What is Bee?

Bee is a client implementation for the Ethereum Swarm network - a decentralized storage and distribution network. This gateway provides read-only access to Swarm content without requiring blockchain interaction or token staking.

## Architecture

### Node Type: Ultra-Light

This setup runs an **ultra-light node** with the following characteristics:

- **Read-only access**: Download files from Swarm
- **No blockchain required**: Operates without connecting to Gnosis Chain
- **No payment system**: SWAP protocol disabled (no xBZZ or xDAI needed)
- **No storage commitment**: Does not participate in data storage or retrieval incentives
- **Free tier**: Suitable for simple content access without earning rewards

### Components

```
┌─────────────────────────────────────┐
│        Docker Container             │
│  ┌───────────────────────────────┐  │
│  │   Bee Ultra-Light Node        │  │
│  │                               │  │
│  │   - API Server (port 1633)   │  │──► External Access
│  │   - P2P Network (port 1634)  │  │──► Swarm Network
│  │   - Local Storage            │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
         │
         ▼
    Docker Volume
    (bee-data)
```

### Ports

- **1633**: HTTP API endpoint for uploading/downloading content
- **1634**: P2P networking port for connecting to other Bee nodes

Both ports are exposed to allow external access to the gateway.

### Configuration

Key settings in `docker-compose.yml`:

- `BEE_FULL_NODE=false`: Runs as a light node
- `BEE_SWAP_ENABLE=false`: Disables payment/incentive system
- `BEE_CORS_ALLOWED_ORIGINS=*`: Allows API access from any origin

## Getting Started

### Prerequisites

- Docker with Docker Compose
- Open ports 1633 and 1634 (or configure firewall accordingly)

### Setup

1. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env and set a secure password
   ```

2. **Start the node**:
   ```bash
   docker compose up -d
   ```

3. **Check node health**:
   ```bash
   curl http://localhost:1633/health
   ```

4. **View logs**:
   ```bash
   docker logs -f bee-gateway
   ```

### Stopping the Node

```bash
docker compose down
```

To remove all data (including downloaded content):
```bash
docker compose down -v
```

## API Usage

### Health Check

```bash
curl http://localhost:1633/health
```

### Node Information

```bash
curl http://localhost:1633/addresses
```

### Download Content

```bash
# Download by Swarm hash
curl http://localhost:1633/bzz/<swarm-hash> -o output.file
```

### API Documentation

Full API documentation available at: https://docs.ethswarm.org/api/

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

## Security Considerations

⚠️ **Current Configuration**: Both ports 1633 and 1634 are exposed on all network interfaces for external access.

**Recommended for production**:
- Use a reverse proxy (nginx, traefik) with TLS termination
- Implement authentication for API access
- Configure firewall rules to restrict access
- Consider using `BEE_CORS_ALLOWED_ORIGINS` with specific domains

## Upgrading

To upgrade to the latest stable version:

```bash
docker compose pull
docker compose up -d
```

## Resources

- **Bee Repository**: https://github.com/ethersphere/bee
- **Swarm Documentation**: https://docs.ethswarm.org/
- **Official Website**: https://www.ethswarm.org/

## License

Bee is licensed under BSD-3-Clause. This configuration repository follows the same license.
