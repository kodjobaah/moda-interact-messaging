import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { getWhatsAppVerifyToken, verifyMetaSignature } from "../app/lib/whatsapp/webhook-auth.server.ts";
import { action, loader } from "../app/routes/whatsapp.tsx";

const webhookUrl = "https://messaging.example/webhook/whatsapp";
const appSecret = "local-arch034-meta-secret";
const verifyToken = "local-arch034-verification-token";

async function withEnvironment(name, value, run) {
  const previous = process.env[name];
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function signedRequest(rawBody, signedBody = rawBody) {
  const digest = createHmac("sha256", appSecret)
    .update(signedBody, "utf8")
    .digest("hex");
  return new Request(webhookUrl, {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    body: rawBody,
  });
}

function loaderRequest(params) {
  const url = new URL(webhookUrl);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return { request: new Request(url) };
}

test("authenticates the exact raw UTF-8 body using HMAC-SHA256", async () => {
  await withEnvironment("META_APP_SECRET", appSecret, () => {
    const body = '{"entry":[],"note":"café"} \n';
    const request = signedRequest(body);
    assert.equal(verifyMetaSignature(request, body), true);
    assert.equal(verifyMetaSignature(request, body.trimEnd()), false);
    assert.equal(verifyMetaSignature(request, body.replace("café", "cafe")), false);
  });
});

test("rejects absent, wrong-length and equal-length incorrect signatures", async () => {
  await withEnvironment("META_APP_SECRET", appSecret, () => {
    const body = '{"entry":[]}';
    assert.equal(verifyMetaSignature(new Request(webhookUrl), body), false);
    assert.equal(verifyMetaSignature(new Request(webhookUrl, {
      headers: { "x-hub-signature-256": "sha256=short" },
    }), body), false);
    assert.equal(verifyMetaSignature(signedRequest(body, '{"entry":[1]}'), body), false);
  });
});

test("preserves missing-secret fail-closed handling and the missing-header short circuit", async () => {
  await withEnvironment("META_APP_SECRET", null, async () => {
    assert.equal(verifyMetaSignature(new Request(webhookUrl), "{}"), false);
    assert.throws(
      () => verifyMetaSignature(signedRequest("{}"), "{}"),
      /META_APP_SECRET is required/,
    );
    await assert.rejects(
      action({ request: signedRequest('{"entry":[]}') }),
      /META_APP_SECRET is required/,
    );
  });
});

test("GET verification accepts matching mode, token and nonempty challenge", async () => {
  await withEnvironment("WHATSAPP_VERIFY_TOKEN", verifyToken, async () => {
    assert.equal(getWhatsAppVerifyToken(), verifyToken);
    const response = await loader(loaderRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": verifyToken,
      "hub.challenge": "12345-challenge",
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(await response.text(), "12345-challenge");
  });
});

test("GET rejects mismatched mode, token and absent challenge without leaking the secret", async () => {
  await withEnvironment("WHATSAPP_VERIFY_TOKEN", verifyToken, async () => {
    for (const params of [
      { "hub.mode": "unsubscribe", "hub.verify_token": verifyToken, "hub.challenge": "challenge" },
      { "hub.mode": "subscribe", "hub.verify_token": "incorrect-token", "hub.challenge": "challenge" },
      { "hub.mode": "subscribe", "hub.verify_token": verifyToken },
    ]) {
      const response = await loader(loaderRequest(params));
      assert.equal(response.status, 403);
      const body = await response.text();
      assert.equal(body, "Forbidden");
      assert.equal(body.includes(verifyToken), false);
    }
  });
});

test("GET preserves failure when WHATSAPP_VERIFY_TOKEN is missing", async () => {
  await withEnvironment("WHATSAPP_VERIFY_TOKEN", null, async () => {
    assert.throws(getWhatsAppVerifyToken, /WHATSAPP_VERIFY_TOKEN is required/);
    await assert.rejects(
      loader(loaderRequest({ "hub.mode": "subscribe", "hub.challenge": "challenge" })),
      /WHATSAPP_VERIFY_TOKEN is required/,
    );
  });
});

test("POST accepts signed JSON with no events without publishing jobs", async () => {
  await withEnvironment("META_APP_SECRET", appSecret, async () => {
    const response = await action({ request: signedRequest('{"entry":[]}') });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "EVENT_RECEIVED");
  });
});

test("POST rejects unsigned and tampered bodies before JSON parsing", async () => {
  await withEnvironment("META_APP_SECRET", appSecret, async () => {
    const unsigned = await action({ request: new Request(webhookUrl, {
      method: "POST",
      body: '{"entry":[]}',
    }) });
    assert.equal(unsigned.status, 401);
    assert.equal(await unsigned.text(), "Unauthorized");

    const tampered = await action({ request: signedRequest("not-json", '{"entry":[]}') });
    assert.equal(tampered.status, 401);
    assert.equal(await tampered.text(), "Unauthorized");

    const signedMalformed = await action({ request: signedRequest("not-json") });
    assert.equal(signedMalformed.status, 400);
    assert.equal(await signedMalformed.text(), "Bad Request");
  });
});

test("POST continues to reject other HTTP methods without checking the signature", async () => {
  const response = await action({ request: new Request(webhookUrl) });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(await response.text(), "Method Not Allowed");
});

test("secret handling remains in a nonlogging .server module", () => {
  const authSource = readFileSync(new URL("../app/lib/whatsapp/webhook-auth.server.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("../app/routes/whatsapp.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(authSource, /\bconsole\./);
  assert.doesNotMatch(routeSource, /\b(?:META_APP_SECRET|WHATSAPP_VERIFY_TOKEN)\b/);
  assert.match(routeSource, /verifyMetaSignature\(request, rawBody\)/);
  assert.ok(routeSource.indexOf("verifyMetaSignature(request, rawBody)") < routeSource.indexOf("JSON.parse(rawBody)"));
});
