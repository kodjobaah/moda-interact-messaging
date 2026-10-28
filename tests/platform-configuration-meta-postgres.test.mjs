import assert from "node:assert/strict";
import { Pool } from "pg";
import { test } from "node:test";

import { createPgMetaConfigRepository } from "../app/lib/platform-configuration/meta-repository.server.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";

test("reads, rotates and revokes only the fixed Meta record in an empty disposable PostgreSQL database", {
  skip: !integrationEnabled || !databaseUrl,
}, async () => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required when disposable integration is enabled");
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname),
    "PostgreSQL integration requires a loopback host");
  assert.match(parsed.pathname.slice(1), /^moda_messaging_disposable_[a-z0-9_]+$/,
    "database name must identify a dedicated disposable Messaging database");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 1_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  const repository = createPgMetaConfigRepository(pool);
  let inserted = false;
  try {
    const count = await pool.query('SELECT COUNT(*)::integer AS count FROM public."PlatformConfiguration"');
    assert.equal(count.rows[0].count, 0,
      "refusing a populated/shared database; use a fresh schema-migrated disposable database");

    await pool.query(
      'INSERT INTO public."PlatformConfiguration" ("id", "environment", "key", "version", "value", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [`messaging-test-${process.pid}`, "test", "messaging.meta", 1, { kind: "disabled", schemaVersion: 1 }],
    );
    inserted = true;
    const initial = await repository.readMeta("test");
    assert.equal(initial?.key, "messaging.meta");
    assert.equal(initial?.version, 1);
    assert.deepEqual(initial?.value, { kind: "disabled", schemaVersion: 1 });

    await pool.query(
      'UPDATE public."PlatformConfiguration" SET "version" = $1, "value" = $2 WHERE "environment" = $3 AND "key" = $4',
      [2, { kind: "disabled", schemaVersion: 1 }, "test", "messaging.meta"],
    );
    assert.equal((await repository.readMeta("test"))?.version, 2);

    await pool.query(
      'DELETE FROM public."PlatformConfiguration" WHERE "environment" = $1 AND "key" = $2',
      ["test", "messaging.meta"],
    );
    inserted = false;
    assert.equal(await repository.readMeta("test"), null);
  } finally {
    if (inserted) {
      await pool.query(
        'DELETE FROM public."PlatformConfiguration" WHERE "environment" = $1 AND "key" = $2',
        ["test", "messaging.meta"],
      );
    }
    await pool.end();
  }
});
