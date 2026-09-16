import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics, trace } from "@opentelemetry/api";

const spans = [];
const counters = [];
const histograms = [];
let failurePoint;

trace.setGlobalTracerProvider({
  getTracer() {
    return {
      startSpan(name, options) {
        if (failurePoint === "tracer") {
          throw new Error("tracer unavailable");
        }

        const span = {
          name,
          attributes: options?.attributes,
          status: undefined,
          setStatus(status) {
            this.status = status;
          },
          end() {},
        };
        spans.push(span);
        return span;
      },
    };
  },
});

metrics.setGlobalMeterProvider({
  getMeter() {
    return {
      createCounter(name) {
        return {
          add(value, attributes) {
            if (failurePoint === "counter") {
              throw new Error("counter unavailable");
            }
            counters.push({ name, value, attributes });
          },
        };
      },
      createHistogram(name) {
        return {
          record(value, attributes) {
            if (failurePoint === "histogram") {
              throw new Error("histogram unavailable");
            }
            histograms.push({ name, value, attributes });
          },
        };
      },
    };
  },
});

const telemetry = await import(
  "../app/lib/observability/whatsapp-ingress-telemetry.ts"
);

test("records bounded acceptance and latency telemetry without sensitive data", () => {
  telemetry.recordWhatsAppIngressTelemetry({
    outcome: "accepted",
    reason: "event_received",
    statusCode: 200,
    durationMs: 12.5,
    message: "customer message",
    customerAddress: "+15555550123",
    accessToken: "secret-token",
    payload: { sensitive: true },
  });

  assert.equal(spans.at(-1).name, "messaging.whatsapp.ingress.process");
  assert.equal(counters.at(-1).name, "messaging.whatsapp.ingress.requests");
  assert.equal(histograms.at(-1).name, "messaging.whatsapp.ingress.duration");
  assert.equal(histograms.at(-1).value, 12.5);

  const expectedAttributes = {
    "messaging.ingress.outcome": "accepted",
    "messaging.ingress.reason": "event_received",
    "messaging.ingress.status_code": 200,
  };
  assert.deepEqual(spans.at(-1).attributes, expectedAttributes);
  assert.deepEqual(counters.at(-1).attributes, expectedAttributes);
  assert.deepEqual(histograms.at(-1).attributes, expectedAttributes);
  assert.deepEqual(
    Object.keys(expectedAttributes),
    telemetry.WHATSAPP_INGRESS_ATTRIBUTE_KEYS,
  );
  assert.doesNotMatch(
    JSON.stringify({ spans, counters, histograms }),
    /customer message|15555550123|secret-token|sensitive/,
  );
});

test("uses only closed metric outcome and reason vocabularies", () => {
  assert.deepEqual(telemetry.WHATSAPP_INGRESS_OUTCOMES, [
    "accepted",
    "rejected",
    "failed",
  ]);
  assert.deepEqual(telemetry.WHATSAPP_INGRESS_REASONS, [
    "event_received",
    "method_not_allowed",
    "invalid_signature",
    "invalid_json",
    "invalid_payload",
    "processing_error",
  ]);
  assert.deepEqual(telemetry.WHATSAPP_INGRESS_STATUS_CODES, [
    200, 400, 401, 405, 500,
  ]);
});

test("records rejected and failed ingress outcomes as errors", () => {
  telemetry.recordWhatsAppIngressTelemetry({
    outcome: "rejected",
    reason: "invalid_signature",
    statusCode: 401,
    durationMs: 2,
  });
  telemetry.recordWhatsAppIngressTelemetry({
    outcome: "failed",
    reason: "processing_error",
    statusCode: 500,
    durationMs: 3,
  });

  assert.equal(spans.at(-2).status.message, "messaging_ingress_invalid_signature");
  assert.equal(spans.at(-1).status.message, "messaging_ingress_processing_error");
  assert.equal(counters.at(-2).attributes["messaging.ingress.outcome"], "rejected");
  assert.equal(counters.at(-1).attributes["messaging.ingress.outcome"], "failed");
});

test("swallows telemetry failures", () => {
  for (const point of ["tracer", "counter", "histogram"]) {
    failurePoint = point;
    assert.doesNotThrow(() =>
      telemetry.recordWhatsAppIngressTelemetry({
        outcome: "accepted",
        reason: "event_received",
        statusCode: 200,
        durationMs: 1,
      }),
    );
  }
});