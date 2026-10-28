import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  hasSyntacticallyValidMetaSignature,
  verifyMetaSignature,
} from "../app/lib/whatsapp/webhook-auth.server.ts";
import { MetaConfigurationFailure } from "../app/lib/platform-configuration/meta-contract.server.ts";
import { action, loader } from "../app/routes/whatsapp.tsx";
import { createMetaCredentialsReader, META_CREDENTIALS } from "./helpers/meta-credentials.mjs";

const webhookUrl = "https://messaging.example/webhook/whatsapp";
const { appSecret, verifyToken } = META_CREDENTIALS;

function signedRequest(rawBody, signedBody = rawBody, secret = appSecret) {
  const digest = createHmac("sha256", secret).update(signedBody, "utf8").digest("hex");
  return new Request(webhookUrl, {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    body: rawBody,
  });
}

function loaderRequest(params) {
  const url = new URL(webhookUrl);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return { request: new Request(url) };
}

test("authenticates the exact raw UTF-8 body using the supplied HMAC secret", () => {
  const body = '{"entry":[],"note":"café"} \n';
  const request = signedRequest(body);
  assert.equal(verifyMetaSignature(request, body, appSecret), true);
  assert.equal(verifyMetaSignature(request, body.trimEnd(), appSecret), false);
  assert.equal(verifyMetaSignature(request, body.replace("café", "cafe"), appSecret), false);
  assert.equal(verifyMetaSignature(request, body, "other-secret"), false);
});

test("rejects absent and malformed signatures before any database read", async () => {
  const fixture = createMetaCredentialsReader();
  const { reader } = fixture;
  for (const request of [
    new Request(webhookUrl, { method: "POST", body: "{}" }),
    new Request(webhookUrl, { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=short" } }),
  ]) {
    assert.equal(hasSyntacticallyValidMetaSignature(request), false);
    const response = await action({ request }, undefined, reader);
    assert.equal(response.status, 401);
  }
  assert.equal(fixture.reads, 0);
});

test("GET reads one snapshot only for a syntactically eligible verification request", async () => {
  const fixture = createMetaCredentialsReader();
  const { reader } = fixture;
  const response = await loader(loaderRequest({
    "hub.mode": "subscribe",
    "hub.verify_token": verifyToken,
    "hub.challenge": "12345-challenge",
  }), reader);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(await response.text(), "12345-challenge");
  assert.equal(fixture.reads, 1);

  for (const params of [
    { "hub.mode": "unsubscribe", "hub.verify_token": verifyToken, "hub.challenge": "challenge" },
    { "hub.mode": "subscribe", "hub.challenge": "challenge" },
    { "hub.mode": "subscribe", "hub.verify_token": verifyToken },
  ]) {
    const rejected = await loader(loaderRequest(params), reader);
    assert.equal(rejected.status, 403);
  }
  assert.equal(fixture.reads, 1);
});

test("GET mismatch uses one database snapshot and configuration failure returns a bounded 503", async () => {
  const mismatch = createMetaCredentialsReader({ credentials: { ...META_CREDENTIALS, verifyToken: "other" } });
  const denied = await loader(loaderRequest({
    "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "challenge",
  }), mismatch.reader);
  assert.equal(denied.status, 403);
  assert.equal(mismatch.reads, 1);

  const unavailable = createMetaCredentialsReader({ failure: new MetaConfigurationFailure("DB_UNAVAILABLE") });
  const response = await loader(loaderRequest({
    "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "challenge",
  }), unavailable.reader);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Service Unavailable");
  assert.equal(unavailable.reads, 1);
});

test("POST uses one fresh snapshot for a signed candidate and keeps signature validation before JSON parsing", async () => {
  const fixture = createMetaCredentialsReader();
  const { reader } = fixture;
  const body = '{"entry":[]}';
  const accepted = await action({ request: signedRequest(body) }, undefined, reader);
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "EVENT_RECEIVED");
  assert.equal(fixture.reads, 1);

  const mismatch = createMetaCredentialsReader({ credentials: { ...META_CREDENTIALS, appSecret: "different" } });
  const denied = await action({ request: signedRequest(body) }, undefined, mismatch.reader);
  assert.equal(denied.status, 401);
  assert.equal(mismatch.reads, 1);

  const malformed = await action({ request: signedRequest("not-json") }, undefined, reader);
  assert.equal(malformed.status, 400);
  assert.equal(fixture.reads, 2);
});

test("signed POST configuration outage returns 503 without dispatch", async () => {
  const fixture = createMetaCredentialsReader({
    failure: new MetaConfigurationFailure("UNSEAL_FAILED"),
  });
  const { reader } = fixture;
  let dispatchCalls = 0;
  const response = await action(
    { request: signedRequest('{"entry":[]}') },
    async () => { dispatchCalls += 1; return "accepted"; },
    reader,
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Service Unavailable");
  assert.equal(fixture.reads, 1);
  assert.equal(dispatchCalls, 0);
});

test("source has no Meta environment-secret getters and never parses JSON before HMAC", () => {
  const authSource = readFileSync(new URL("../app/lib/whatsapp/webhook-auth.server.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("../app/routes/whatsapp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(authSource, /\b(?:META_APP_SECRET|WHATSAPP_VERIFY_TOKEN|getWhatsAppVerifyToken|getMetaAppSecret)\b/);
  assert.doesNotMatch(routeSource, /\b(?:META_APP_SECRET|WHATSAPP_VERIFY_TOKEN)\b/);
  assert.match(routeSource, /verifyMetaSignature\(request, rawBody, snapshot\.value\.appSecret\)/);
  assert.ok(routeSource.indexOf("verifyMetaSignature(request, rawBody, snapshot.value.appSecret)") < routeSource.indexOf("JSON.parse(rawBody)"));
});
