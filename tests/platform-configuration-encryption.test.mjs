import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDeploymentEncryptionKeyring } from "../app/lib/platform-configuration/meta-production.server.ts";
const key = Buffer.alloc(32, 17).toString("base64");
test("Messaging uses the unified map while preserving historical decryption IDs", () => {
  const ring = loadDeploymentEncryptionKeyring({ MODA_ENCRYPTION_KEYS_JSON: JSON.stringify({ historical: key, current: Buffer.alloc(32, 34).toString("base64") }), MODA_ENCRYPTION_ACTIVE_KEY_ID: "current" });
  assert.deepEqual(ring.keyIds, ["current", "historical"]);
});
test("missing map, invalid active selection, and legacy-only configuration fail closed", () => {
  for (const environment of [{}, { MODA_ENCRYPTION_KEYS_JSON: "{}", MODA_ENCRYPTION_ACTIVE_KEY_ID: "missing" }, { MODA_ENCRYPTION_KEYS_JSON: JSON.stringify({ current: key }), MODA_ENCRYPTION_ACTIVE_KEY_ID: "missing" }, { MODA_CONFIG_UNSEAL_KEY: JSON.stringify({ current: key }), MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID: "current" }]) {
    assert.throws(() => loadDeploymentEncryptionKeyring(environment), error => error.code === "UNSEAL_FAILED");
  }
});
