import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";

export const WHATSAPP_INGRESS_OUTCOMES = [
  "accepted",
  "rejected",
  "failed",
] as const;

export const WHATSAPP_INGRESS_REASONS = [
  "event_received",
  "method_not_allowed",
  "invalid_signature",
  "invalid_json",
  "processing_error",
] as const;

export const WHATSAPP_INGRESS_STATUS_CODES = [200, 400, 401, 405, 500] as const;

export const WHATSAPP_INGRESS_ATTRIBUTE_KEYS = [
  "messaging.ingress.outcome",
  "messaging.ingress.reason",
  "messaging.ingress.status_code",
] as const;

type WhatsAppIngressOutcome = (typeof WHATSAPP_INGRESS_OUTCOMES)[number];
type WhatsAppIngressReason = (typeof WHATSAPP_INGRESS_REASONS)[number];
type WhatsAppIngressStatusCode = (typeof WHATSAPP_INGRESS_STATUS_CODES)[number];

export type WhatsAppIngressObservation = {
  outcome: WhatsAppIngressOutcome;
  reason: WhatsAppIngressReason;
  statusCode: WhatsAppIngressStatusCode;
  durationMs: number;
};

const instrumentationName = "moda-interact-messaging.whatsapp.ingress";
const tracer = trace.getTracer(instrumentationName);
const meter = metrics.getMeter(instrumentationName);
const requests = meter.createCounter("messaging.whatsapp.ingress.requests", {
  description: "Meta WhatsApp ingress requests by bounded outcome.",
  unit: "1",
});
const duration = meter.createHistogram(
  "messaging.whatsapp.ingress.duration",
  {
    description: "Meta WhatsApp ingress acknowledgement latency.",
    unit: "ms",
  },
);

export function recordWhatsAppIngressTelemetry(
  observation: WhatsAppIngressObservation,
): void {
  try {
    const attributes: Attributes = {
      "messaging.ingress.outcome": observation.outcome,
      "messaging.ingress.reason": observation.reason,
      "messaging.ingress.status_code": observation.statusCode,
    };
    const durationMs = Math.max(0, observation.durationMs);
    const span = tracer.startSpan("messaging.whatsapp.ingress.process", {
      attributes,
      startTime: Date.now() - durationMs,
    });

    if (observation.outcome !== "accepted") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `messaging_ingress_${observation.reason}`,
      });
    }

    span.end();
    requests.add(1, attributes);
    duration.record(durationMs, attributes);
  } catch {
    // Semantic telemetry is best-effort and cannot affect webhook handling.
  }
}