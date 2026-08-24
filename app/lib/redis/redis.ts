import { Redis } from "ioredis";

let redis: Redis | null = null;

export function getRedis() {
  if (redis) {
    return redis;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      "REDIS_URL environment variable is required",
    );
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  return redis;
}