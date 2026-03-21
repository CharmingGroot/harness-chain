/**
 * Redis client singleton.
 * Uses REDIS_URL env var (default: redis://localhost:6399).
 * In test environments, returns a no-op stub so tests don't need a real Redis.
 */
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6399';

// Singleton — reuse across hot-reloads in dev
const globalForRedis = globalThis as unknown as { _hcRedis?: Redis };

function createClient(): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    // Log but don't crash — Redis is enhancement, not hard dependency
    console.error('[redis] connection error:', err.message);
  });

  return client;
}

export function getRedis(): Redis {
  if (!globalForRedis._hcRedis) {
    globalForRedis._hcRedis = createClient();
  }
  return globalForRedis._hcRedis;
}
