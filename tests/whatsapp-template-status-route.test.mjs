import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { action } from "../app/routes/whatsapp.tsx";
import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";
import { createMetaCredentialsReader, META_CREDENTIALS } from "./helpers/meta-credentials.mjs";

const endpoint = "https://messaging.example/webhook/whatsapp";
const appSecret = META_CREDENTIALS.appSecret;
const metaReader = createMetaCredentialsReader().reader;
const change = (overrides = {}) => ({
  field: "message_template_status_update",
  value: {
    message_template_id: "987654321", message_template_name: "checkout_recovery_initial_v2",
    message_template_language: "en_GB", event: "APPROVED", reason: "NONE", ...overrides,
  },
});
const payload = (...changes) => ({ object: "whatsapp_business_account", entry: [{ id: "123456789", changes }] });

async function withCredentials(fn) { return fn(); }
function signedRequest(body, signedBody = body) {
  const signature = createHmac("sha256", appSecret).update(signedBody, "utf8").digest("hex");
  return new Request(endpoint, { method: "POST", body, headers: { "x-hub-signature-256": `sha256=${signature}` } });
}
function recorder() {
  const calls = [];
  return {
    calls,
    dispatch: (event) => dispatchWhatsAppWebhook(event, {
      async enqueueInboundMessage(item) { calls.push(["inbound", item]); },
      async enqueueProviderStatus(item) { calls.push(["status", item]); },
      async enqueueTemplateStatus(item) { calls.push(["template", item]); },
    }),
  };
}

test("signed template callbacks publish every change and return 200 only after publication", async () => withCredentials(async () => {
  const { calls, dispatch } = recorder();
  const body = `${JSON.stringify(payload(change(), change({ event: "PAUSED", reason: null })))}\n`;
  const response = await action({ request: signedRequest(body) }, dispatch, metaReader);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "EVENT_RECEIVED");
  assert.deepEqual(calls.map(([kind, value]) => [kind, value.providerStatus]), [["template", "APPROVED"], ["template", "PAUSED"]]);
  assert.equal(calls[0][1].wabaId, "123456789");
  assert.equal(calls[1][1].reasonCode, null);
  assert.notEqual(calls[0][1].eventIdentity, calls[1][1].eventIdentity);
}));

test("invalid signed later change rejects the whole request with zero publications", async () => withCredentials(async () => {
  for (const bad of [change({ message_template_name: " " }), change({ message_template_id: 9007199254740992 }), change({ event: "a".repeat(40) })]) {
    const { calls, dispatch } = recorder();
    const request = signedRequest(JSON.stringify(payload(change(), bad)));
    const response = await action({ request }, dispatch, metaReader);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Bad Request");
    assert.deepEqual(calls, []);
  }
}));

test("unsigned, tampered, malformed JSON and wrong-method requests preserve HTTP behavior", async () => withCredentials(async () => {
  const { calls, dispatch } = recorder();
  const body = JSON.stringify(payload(change()));
  const noSignature = await action({ request: new Request(endpoint, { method: "POST", body }) }, dispatch, metaReader);
  assert.equal(noSignature.status, 401);
  const tampered = await action({ request: signedRequest(body, JSON.stringify(payload(change({ event: "REJECTED" })))) }, dispatch, metaReader);
  assert.equal(tampered.status, 401);
  const malformed = await action({ request: signedRequest("not-json") }, dispatch, metaReader);
  assert.equal(malformed.status, 400);
  const wrongMethod = await action({ request: new Request(endpoint, { method: "GET" }) }, dispatch, metaReader);
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(calls, []);
}));

test("queue failure rejects provider acknowledgement (no false 200)", async () => withCredentials(async () => {
  const failure = new Error("queue add failed");
  let published = 0;
  const dispatcher = (event) => dispatchWhatsAppWebhook(event, {
    async enqueueInboundMessage() { throw new Error("unexpected inbound"); },
    async enqueueProviderStatus() { throw new Error("unexpected status"); },
    async enqueueTemplateStatus() { published++; throw failure; },
  });
  await assert.rejects(action({ request: signedRequest(JSON.stringify(payload(change()))) }, dispatcher, metaReader), (error) => error === failure);
  assert.equal(published, 1);
}));

test("configuration failure fails closed for signed template changes", async () => {
  const unavailableReader = createMetaCredentialsReader({
    failure: new (await import("../app/lib/platform-configuration/meta-contract.server.ts")).MetaConfigurationFailure("MISSING"),
  }).reader;
  const response = await action({ request: signedRequest(JSON.stringify(payload(change()))) }, undefined, unavailableReader);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Service Unavailable");
});
