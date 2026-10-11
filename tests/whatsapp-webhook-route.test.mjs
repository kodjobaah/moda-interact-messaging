import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { dispatchWhatsAppWebhook } from "../app/lib/whatsapp/webhook-dispatch.server.ts";
import { action } from "../app/routes/whatsapp.tsx";

const endpoint = "https://messaging.example/webhook/whatsapp";
const appSecret = "arch034-m004-webhook-test-secret";

async function withSecret(run) {
  const old = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = appSecret;
  try {
    return await run();
  } finally {
    if (old === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = old;
  }
}

function requestWithBody(body, signedBody = body) {
  const signature = createHmac("sha256", appSecret).update(signedBody, "utf8").digest("hex");
  return new Request(endpoint, {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

function text(id, value = "hello") {
  return { id, from: "15555550123", timestamp: "1788144000", type: "text", text: { body: value } };
}

function mixedWebhook() {
  return {
    entry: [{
      id: "waba-1",
      changes: [
        { field: "template", value: null },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "phone-1" },
            messages: [text("in-1")],
            statuses: [
              { status: "sent", timestamp: "1788144000" },
              { id: "out-1", status: "failed", timestamp: "1788144000", errors: [{ code: 131026 }] },
            ],
          },
        },
      ],
    }],
  };
}

test("framework action preserves a real signed no-op webhook response", async () => {
  await withSecret(async () => {
    const response = await action({ request: requestWithBody('{"entry":[]}') });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "EVENT_RECEIVED");
  });
});

test("signed mixed HTTP payload traverses dispatcher and returns 200 in original order", async () => {
  await withSecret(async () => {
    const recorded = [];
    const publisher = {
      async enqueueInboundMessage(event) { recorded.push(["message-received", event]); },
      async enqueueProviderStatus(event) { recorded.push(["message-status", event]); },
    };
    const payload = mixedWebhook();
    const body = `${JSON.stringify(payload)}
`;
    const response = await action(
      { request: requestWithBody(body) },
      (parsed) => dispatchWhatsAppWebhook(parsed, publisher),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "EVENT_RECEIVED");
    assert.deepEqual(recorded.map(([name, event]) => [name, event.providerMessageId]), [
      ["message-received", "in-1"],
      ["message-status", "out-1"],
    ]);
    assert.deepEqual(recorded[1][1].failure, { providerCode: "131026" });
  });
});

test("bad signatures, invalid JSON and wrong methods never invoke dispatcher", async () => {
  await withSecret(async () => {
    let dispatchCalls = 0;
    const dispatch = async () => { dispatchCalls++; return "accepted"; };

    const unauthorized = await action({ request: requestWithBody("not-json", '{"entry":[]}') }, dispatch);
    assert.equal(unauthorized.status, 401);
    assert.equal(await unauthorized.text(), "Unauthorized");

    const invalidJson = await action({ request: requestWithBody("not-json") }, dispatch);
    assert.equal(invalidJson.status, 400);
    assert.equal(await invalidJson.text(), "Bad Request");

    const wrongMethod = await action({ request: new Request(endpoint) }, dispatch);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal(dispatchCalls, 0);
  });
});

test("a late invalid inbound returns 400 even after earlier successful publication", async () => {
  await withSecret(async () => {
    const payload = mixedWebhook();
    payload.entry[0].changes.push({
      field: "messages",
      value: { metadata: { phone_number_id: "phone-1" }, messages: [text("invalid", "")] },
    });
    const seen = [];
    const publisher = {
      async enqueueInboundMessage(event) { seen.push(event.providerMessageId); },
      async enqueueProviderStatus(event) { seen.push(event.providerMessageId); },
    };
    const response = await action(
      { request: requestWithBody(JSON.stringify(payload)) },
      (parsed) => dispatchWhatsAppWebhook(parsed, publisher),
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Bad Request");
    assert.deepEqual(seen, ["in-1", "out-1"]);
  });
});

test("publisher errors still propagate through the HTTP failure boundary", async () => {
  await withSecret(async () => {
    const failure = new Error("synthetic publisher failure");
    await assert.rejects(
      action({ request: requestWithBody(JSON.stringify(mixedWebhook())) }, async () => { throw failure; }),
      (error) => error === failure,
    );
  });
});

test("malformed signed JSON envelopes retain pre-MESSAGING-005 exception behaviour", async () => {
  await withSecret(async () => {
    await assert.rejects(
      action({ request: requestWithBody("null") }, dispatchWhatsAppWebhook),
      TypeError,
    );
  });
});
