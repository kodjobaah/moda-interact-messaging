import { getRedis } from "~/lib/redis/redis";

const REDIS_READINESS_TIMEOUT_MS = 1_000;

type ReadinessDependencies = {
  redisPing?: () => Promise<unknown>;
  timeoutMs?: number;
};

export async function loader() {
  return createReadinessResponse();
}

/**
 * Implements the readiness contract with an injectable Redis probe.
 *
 * Production uses getRedis().ping(). Repository tests inject deterministic
 * probes so they never create a long-lived ioredis reconnect loop. Real Redis
 * behavior is exercised by architecture/system tests with ephemeral Redis.
 */
export async function createReadinessResponse(
  dependencies: ReadinessDependencies = {},
): Promise<Response> {
  const redisPing = dependencies.redisPing ?? (() => getRedis().ping());
  const timeoutMs = dependencies.timeoutMs ?? REDIS_READINESS_TIMEOUT_MS;

  try {
    await withTimeout(redisPing(), timeoutMs);
    return json({ status: "ready" });
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}

function json(body: { status: string }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Redis readiness check timed out")),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
