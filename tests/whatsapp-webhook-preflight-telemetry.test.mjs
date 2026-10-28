import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import {
  createMetaCredentialsReader,
  META_CREDENTIALS,
} from "./helpers/meta-credentials.mjs";

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

const secret = META_CREDENTIALS.appSecret;
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
  // ARCH-043: webhook credentials come from the platform configuration reader.
  // The obsolete META_APP_SECRET environment variable is no longer consulted.
  const credentials = createMetaCredentialsReader();
  const response = await action(
    { request: signedRequest('{"entry":[null]}') },
    undefined,
    credentials.reader,
  );
  assert.equal(credentials.reads, 1);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Bad Request");
  assert.deepEqual(observations.at(-1), {
    "messaging.ingress.outcome": "rejected",
    "messaging.ingress.reason": "invalid_payload",
    "messaging.ingress.status_code": 400,
  });
});
