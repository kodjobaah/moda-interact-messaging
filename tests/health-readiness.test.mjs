import assert from "node:assert/strict";
import { test } from "node:test";

import { loader as healthLoader } from "../app/routes/health.ts";
import { createReadinessResponse } from "../app/routes/ready.ts";

test("health is a dependency-free liveness check", async () => {
  const response = await healthLoader();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("ready reports Redis availability without sensitive details", async () => {
  let redisCalls = 0;

  const response = await createReadinessResponse({
    redisPing: async () => {
      redisCalls += 1;
      return "PONG";
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.equal(redisCalls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("ready fails predictably when Redis is unavailable", async () => {
  const response = await createReadinessResponse({
    redisPing: async () => {
      throw new Error("simulated Redis outage");
    },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "unavailable" });
});

test("ready bounds a Redis probe that never settles", async () => {
  const startedAt = Date.now();

  const response = await createReadinessResponse({
    redisPing: () => new Promise(() => {}),
    timeoutMs: 20,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "unavailable" });
  assert.ok(Date.now() - startedAt < 500, "readiness timeout must be bounded");
});
