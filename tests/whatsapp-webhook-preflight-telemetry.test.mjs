import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";

const observations = [];
metrics.setGlobalMeterProvider({
  getMeter() {
    return {
      createCounter() {
        return { add(_value, attributes) { observations.push(attributes); } };
      },
      createHistogram() {
        return { record() {} };
      },
    };
  },
});

// Load after installing the test meter: verify the real route-to-telemetry path.
const { action } = await import("../app/routes/whatsapp.tsx");

const secret = "arch034-preflight-telemetry-test";
const endpoint = "https://messaging.example/webhook/whatsapp";

function signedRequest(body) {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request(endpoint, {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

test("invalid signed envelope produces bounded invalid_payload telemetry", async () => {
  const previous = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = secret;
  try {
    const response = await action({ request: signedRequest('{"entry":[null]}') });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Bad Request");
    assert.deepEqual(observations.at(-1), {
      "messaging.ingress.outcome": "rejected",
      "messaging.ingress.reason": "invalid_payload",
      "messaging.ingress.status_code": 400,
    });
  } finally {
    if (previous === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previous;
  }
});
