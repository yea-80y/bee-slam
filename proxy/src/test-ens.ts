import { ethers } from 'ethers';

const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:3000';
const RPC_URL = process.env.RPC_URL ?? 'https://eth.llamarpc.com';

/**
 * Decode a content hash from ENS to extract the Swarm hash
 * Content hashes can be in different formats:
 * - Human readable: bzz://<hash>
 * - Raw hex: 0xe40101<hash>
 */
function decodeSwarmHash(contentHash: string): string {
  // Handle human-readable format (bzz://hash)
  if (contentHash.startsWith('bzz://')) {
    const swarmHash = contentHash.slice(6); // Remove 'bzz://'
    return swarmHash;
  }

  // Handle raw hex format
  const hex = contentHash.startsWith('0x') ? contentHash.slice(2) : contentHash;

  // Swarm content hash starts with e40101 (codec for bzz)
  if (hex.startsWith('e40101')) {
    // Extract the hash part (skip the codec bytes)
    // e40101 = 3 bytes, then comes the hash
    const swarmHash = hex.slice(6); // Skip 'e40101'
    return swarmHash;
  }

  throw new Error(`Unknown content hash format: ${contentHash}`);
}

async function resolveENSContent(ensName: string): Promise<string> {
  console.log(`\n🔍 Resolving ENS name: ${ensName}`);
  console.log(`📡 Using RPC: ${RPC_URL}\n`);

  // Connect to Ethereum mainnet
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Resolve the ENS name
  const resolver = await provider.getResolver(ensName);

  if (!resolver) {
    throw new Error(`No resolver found for ${ensName}`);
  }

  console.log(`✅ Found resolver for ${ensName}`);

  // Get the content hash
  const contentHash = await resolver.getContentHash();

  if (!contentHash) {
    throw new Error(`No content hash set for ${ensName}`);
  }

  console.log(`📦 Raw content hash: ${contentHash}`);

  // Decode the Swarm hash
  const swarmHash = decodeSwarmHash(contentHash);
  console.log(`🐝 Swarm hash: ${swarmHash}`);

  return swarmHash;
}

async function addToWhitelist(hash: string): Promise<void> {
  console.log(`\n➕ Adding hash to whitelist...`);

  const response = await fetch(`${PROXY_URL}/admin/whitelist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hash }),
  });

  if (!response.ok) {
    throw new Error(`Failed to add to whitelist: ${response.statusText}`);
  }

  const result = await response.json();
  console.log(`✅ Added to whitelist. Total hashes: ${result.count}`);
}

async function testBzzAccess(hash: string): Promise<void> {
  console.log(`\n🧪 Testing /bzz endpoint access...`);

  const url = `${PROXY_URL}/bzz/${hash}`;
  console.log(`📡 Fetching: ${url}`);

  const response = await fetch(url);

  console.log(`📊 Response status: ${response.status} ${response.statusText}`);
  console.log(`📋 Content-Type: ${response.headers.get('content-type')}`);
  console.log(`📏 Content-Length: ${response.headers.get('content-length') ?? 'unknown'}`);

  if (response.ok) {
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('text/html')) {
      const text = await response.text();
      const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
      console.log(`\n📄 Content preview:\n${preview}\n`);
    } else if (contentType?.includes('application/json')) {
      const json = await response.json();
      console.log(`\n📄 JSON content:\n${JSON.stringify(json, null, 2)}\n`);
    } else {
      console.log(`\n✅ Successfully fetched content (${response.headers.get('content-length')} bytes)`);
    }
  } else {
    const errorText = await response.text();
    console.error(`\n❌ Failed to fetch content:\n${errorText}\n`);
  }
}

async function main(): Promise<void> {
  try {
    const ensName = process.argv[2] ?? 'woco.eth';

    console.log('════════════════════════════════════════════════');
    console.log('  ENS to Swarm Gateway Test');
    console.log('════════════════════════════════════════════════');

    // Step 1: Resolve ENS to Swarm hash
    const swarmHash = await resolveENSContent(ensName);

    // Step 2: Add to whitelist
    await addToWhitelist(swarmHash);

    // Step 3: Test access through proxy
    await testBzzAccess(swarmHash);

    console.log('\n════════════════════════════════════════════════');
    console.log('✅ Test completed successfully!');
    console.log('════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();
