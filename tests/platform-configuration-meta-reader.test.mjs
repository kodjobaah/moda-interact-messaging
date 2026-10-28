import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";

import {
  META_CONFIGURATION_KEY,
  MetaConfigurationFailure,
} from "../app/lib/platform-configuration/meta-contract.server.ts";
import { createPgMetaConfigRepository } from "../app/lib/platform-configuration/meta-repository.server.ts";
import { createMetaWebhookCredentialsReader } from "../app/lib/platform-configuration/meta-reader.server.ts";

const keyringJson = JSON.stringify({
  wrap_old: Buffer.alloc(32, 17).toString("base64"),
  wrap_new: Buffer.alloc(32, 34).toString("base64"),
});
const parseKeyring = () => parseCredentialKeyring(keyringJson);
const oldEnvelope = Object.freeze({
  kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: "wrap_old",
  nonce: "1RPzP2BzutkyaxSC",
  ciphertext: "4HdKrTKDSzECxgjZ7cZB3J8bVLor5OSOxrVFqL+FsyraOvK1jbz7ov9W+5CNYJGMaGDmBTCrGZGjwvB6OjS8+Sk36dljCQgqNH5AiBT+LytVl1rc/XmI",
  authTag: "Yetg+wM5taK+TjIvBa5/HA==",
});
const newEnvelope = Object.freeze({
  kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: "wrap_new",
  nonce: "Sqm72VP+0EQNDUlo",
  ciphertext: "gLIQoPLSy7T7PWihjnoXkwGegkrR7HqhY0Sl3DtiRBIYDcvzDOibCOSeFd4ONeCzSuWKz2vdvviQwZ6+jRYSlo4HUwGvrOgqO6+yF3g5q/06tN4hxJ//",
  authTag: "xeyoJvqI+FbZFxN0r3johA==",
});

function row(value = oldEnvelope, overrides = {}) {
  return {
    environment: "test",
    key: META_CONFIGURATION_KEY,
    version: value === newEnvelope ? 8 : 7,
    value,
    ...overrides,
  };
}

function readerFor({ getRow = async () => row(), environment = "test", unsealKeyring = parseKeyring, logger } = {}) {
  let reads = 0;
  const reader = createMetaWebhookCredentialsReader({
    repository: { async readMeta(env) { reads += 1; return getRow(env); } },
    environment,
    unsealKeyring,
    logger,
  });
  return { reader, get reads() { return reads; } };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof MetaConfigurationFailure && error.code === code);
}

test("reads the fixed Admin-compatible v1 ciphertext and returns only the frozen credential snapshot", async () => {
  const events = [];
  const fixture = readerFor({ logger: {
    info(event, fields) { events.push(["info", event, fields]); },
    warn(event, fields) { events.push(["warn", event, fields]); },
  } });
  const snapshot = await fixture.reader.read();
  assert.deepEqual(snapshot, {
    key: "messaging.meta",
    version: 7,
    value: { appSecret: "fixture-meta-app-secret-v1", verifyToken: "fixture-meta-verify-token-v1" },
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.value), true);
  assert.equal(fixture.reads, 1);
  assert.deepEqual(events, [["info", "messaging.platform_configuration.read_succeeded", { key: "messaging.meta", version: 7 }]]);
  assert.doesNotMatch(JSON.stringify(events), /fixture-meta|1RPzP2|ciphertext|authTag/);
});

test("reads a fresh row on every operation and supports old-key rows during wrapping-key rotation", async () => {
  let current = row();
  let keyringCalls = 0;
  const fixture = readerFor({
    getRow: async () => current,
    unsealKeyring: () => { keyringCalls += 1; return parseKeyring(); },
  });
  const previous = await fixture.reader.read();
  current = row(newEnvelope);
  const rotated = await fixture.reader.read();
  assert.equal(previous.version, 7);
  assert.equal(previous.value.verifyToken, "fixture-meta-verify-token-v1");
  assert.equal(rotated.version, 8);
  assert.equal(rotated.value.verifyToken, "fixture-meta-verify-token-v2");
  assert.equal(fixture.reads, 2);
  assert.equal(keyringCalls, 2);
});

test("distinguishes missing, disabled and invalid records", async () => {
  await rejectsCode(readerFor({ getRow: async () => null }).reader.read(), "MISSING");
  await rejectsCode(readerFor({ getRow: async () => row({ kind: "disabled", schemaVersion: 1 }) }).reader.read(), "DISABLED");
  await rejectsCode(readerFor({ getRow: async () => row({ kind: "disabled", schemaVersion: 1, extra: true }) }).reader.read(), "INVALID");
  await rejectsCode(readerFor({ getRow: async () => row(oldEnvelope, { environment: "production" }) }).reader.read(), "INVALID");
  await rejectsCode(readerFor({ getRow: async () => row(oldEnvelope, { key: "messaging.sender" }) }).reader.read(), "INVALID");
  await rejectsCode(readerFor({ getRow: async () => row(oldEnvelope, { version: 0 }) }).reader.read(), "INVALID");
  await assert.rejects(
    Promise.resolve().then(() => createMetaWebhookCredentialsReader({
      repository: { async readMeta() { return null; } },
      environment: "production ",
      unsealKeyring: parseKeyring,
    })),
    (error) => error instanceof MetaConfigurationFailure && error.code === "INVALID",
  );
});

test("rejects malformed envelope fields, noncanonical encodings, tampering and changed AAD", async () => {
  const mutations = [
    { ...oldEnvelope, extra: "field" },
    { ...oldEnvelope, algorithm: "AES-128-GCM" },
    { ...oldEnvelope, schemaVersion: 2 },
    { ...oldEnvelope, wrappingKeyId: "constructor" },
    { ...oldEnvelope, nonce: `${oldEnvelope.nonce}==` },
    { ...oldEnvelope, ciphertext: "***" },
    { kind: "plaintext", appSecret: "not-allowed" },
  ];
  for (const value of mutations) {
    await rejectsCode(readerFor({ getRow: async () => row(value) }).reader.read(), "INVALID");
  }
  await rejectsCode(readerFor({
    getRow: async () => row({ ...oldEnvelope, ciphertext: Buffer.from("tampered").toString("base64") }),
  }).reader.read(), "UNSEAL_FAILED");
  await rejectsCode(readerFor({
    getRow: async () => row({ ...oldEnvelope, authTag: "AAAAAAAAAAAAAAAAAAAAAA==" }),
  }).reader.read(), "UNSEAL_FAILED");
  await rejectsCode(readerFor({
    environment: "development",
    getRow: async () => row(oldEnvelope, { environment: "development" }),
  }).reader.read(), "UNSEAL_FAILED");
  await rejectsCode(readerFor({
    getRow: async () => row(oldEnvelope, { version: 8 }),
  }).reader.read(), "UNSEAL_FAILED");
  await rejectsCode(readerFor({ unsealKeyring: () => { throw new Error("private keyring detail"); } }).reader.read(), "UNSEAL_FAILED");
});

test("maps repository outages, redacts logs and leaves unexpected errors visible", async () => {
  const logs = [];
  const logger = {
    info(event, fields) { logs.push([event, fields]); },
    warn(event, fields) { logs.push([event, fields]); },
  };
  const outage = readerFor({
    getRow: async () => { throw new MetaConfigurationFailure("DB_UNAVAILABLE"); },
    logger,
  });
  await rejectsCode(outage.reader.read(), "DB_UNAVAILABLE");
  assert.equal(logs[0][1].reasonCode, "DB_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(logs), /private|ciphertext|fixture-meta|database url/);

  const unexpected = new Error("raw database detail");
  const broken = readerFor({ getRow: async () => { throw unexpected; }, logger });
  await assert.rejects(broken.reader.read(), (error) => error === unexpected);
  assert.equal(logs.at(-1)[1].reasonCode, "UNEXPECTED");

  const loggerFailure = readerFor({ logger: { info() { throw new Error("sink failure"); }, warn() { throw new Error("sink failure"); } } });
  assert.equal((await loggerFailure.reader.read()).value.appSecret, "fixture-meta-app-secret-v1");
});

test("parameterizes the single fixed-purpose PostgreSQL query and rejects duplicate rows", async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [row()] };
    },
  };
  const repository = createPgMetaConfigRepository(db);
  assert.deepEqual(await repository.readMeta("test"), row());
  assert.deepEqual(calls[0].values, ["test", "messaging.meta"]);
  assert.match(calls[0].sql, /WHERE "environment" = \$1 AND "key" = \$2\s+LIMIT 2/);
  assert.doesNotMatch(calls[0].sql, /messaging\.sender|SELECT \*/);
  await assert.rejects(repository.readMeta("production; DROP TABLE"), (error) => error.code === "INVALID");

  const duplicates = createPgMetaConfigRepository({ query: async () => ({ rows: [row(), row()] }) });
  await rejectsCode(duplicates.readMeta("test"), "DB_UNAVAILABLE");
  const databaseFailure = createPgMetaConfigRepository({ query: async () => { throw new Error("secret DSN"); } });
  await rejectsCode(databaseFailure.readMeta("test"), "DB_UNAVAILABLE");
});
