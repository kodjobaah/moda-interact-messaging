import crypto from "node:crypto";

import {
  safeParseNormalizedWhatsAppStatus,
} from "@modainteract/moda-interact-shared";
import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  recordWhatsAppIngressTelemetry,
  type WhatsAppIngressObservation,
} from "~/lib/observability/whatsapp-ingress-telemetry";
import { getWhatsAppQueue } from "~/lib/queues/whatsapp.queue";

import type {
  WhatsAppInboundEvent,
  WhatsAppMessageType,
} from "~/lib/types/whatsapp";

/**
 * Meta webhook verification.
 *
 * GET /webhook/whatsapp
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verifyToken = getWhatsAppVerifyToken();

  if (mode === "subscribe" && token === verifyToken && challenge) {
    console.log("WhatsApp webhook verified");

    return new Response(challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }

  console.warn("WhatsApp webhook verification failed");

  return new Response("Forbidden", {
    status: 403,
  });
}

/**
 * Actual WhatsApp webhook.
 *
 * POST /webhook/whatsapp
 */
export async function action({ request }: ActionFunctionArgs) {
  const startedAt = performance.now();

  try {
    if (request.method !== "POST") {
      return observedResponse(
        "Method Not Allowed",
        {
          status: 405,
          headers: {
            Allow: "POST",
          },
        },
        startedAt,
        { outcome: "rejected", reason: "method_not_allowed" },
      );
    }

    const rawBody = await request.text();

    if (!verifyMetaSignature(request, rawBody)) {
      console.error("Invalid Meta webhook signature");

      return observedResponse(
        "Unauthorized",
        { status: 401 },
        startedAt,
        { outcome: "rejected", reason: "invalid_signature" },
      );
    }

    let payload: any;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.error("Invalid WhatsApp webhook JSON");

      return observedResponse(
        "Bad Request",
        { status: 400 },
        startedAt,
        { outcome: "rejected", reason: "invalid_json" },
      );
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") {
          continue;
        }

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          continue;
        }

        /*
         * Incoming customer messages
         */
        for (const message of value.messages ?? []) {
          await handleInboundMessage({
            phoneNumberId,
            message,
          });
        }

        /*
         * Status updates for messages we previously sent
         */
        for (const status of value.statuses ?? []) {
          await handleProviderStatus({
            entry,
            change,
            status,
          });
        }
      }
    }

    return observedResponse(
      "EVENT_RECEIVED",
      { status: 200 },
      startedAt,
      { outcome: "accepted", reason: "event_received" },
    );
  } catch (error) {
    recordWhatsAppIngressTelemetry({
      outcome: "failed",
      reason: "processing_error",
      statusCode: 500,
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }
}

async function handleProviderStatus({
  entry,
  change,
  status,
}: {
  entry?: unknown;
  change?: unknown;
  status: unknown;
}) {
  const normalized = normalizeProviderStatusFromWebhook({ entry, change, status });

  if (!normalized) {
    return;
  }

  const whatsappQueue = getWhatsAppQueue();
  await whatsappQueue.add("message-status", normalized, {
    jobId: createStatusJobId(normalized),
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

export function normalizeProviderStatusFromWebhook({
  entry,
  change,
  status,
}: {
  entry?: unknown;
  change?: unknown;
  status: unknown;
}): NormalizedWhatsAppStatus | null {
  const entryRecord = asRecord(entry);
  const changeRecord = asRecord(change);
  const valueRecord = asRecord(changeRecord?.value);
  const metadataRecord = asRecord(valueRecord?.metadata);

  return normalizeProviderStatus({
    entryId: entryRecord?.id,
    phoneNumberId: metadataRecord?.phone_number_id,
    status,
  });
}

export function normalizeProviderStatus({
  entryId,
  phoneNumberId,
  status,
}: {
  entryId?: unknown;
  phoneNumberId?: unknown;
  status: any;
}): NormalizedWhatsAppStatus | null {
  const providerAccountId = typeof entryId === "string" ? entryId.trim() : "";
  const providerPhoneNumberId = typeof phoneNumberId === "string" ? phoneNumberId.trim() : "";
  const providerMessageId = typeof status?.id === "string" ? status.id.trim() : "";
  const normalizedStatus = normalizeProviderStatusName(status?.status);
  const occurredAt = normalizeOccurredAt(status?.timestamp);

  if (!providerAccountId || !providerPhoneNumberId || !providerMessageId || !normalizedStatus || !occurredAt) {
    return null;
  }

  const candidate = {
    schemaVersion: 2,
    providerAccountId,
    providerPhoneNumberId,
    providerMessageId,
    status: normalizedStatus,
    occurredAt,
    pricing: normalizePricing(status?.pricing),
  };
  if (!candidate.pricing) delete candidate.pricing;

  const parsed = safeParseNormalizedWhatsAppStatus(candidate);
  return parsed.success ? parsed.data : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function normalizeProviderStatusName(value: unknown): NormalizedWhatsAppStatus["status"] | null {
  switch (value) {
    case "sent": return "SENT";
    case "delivered": return "DELIVERED";
    case "read": return "READ";
    case "failed": return "FAILED";
    default: return null;
  }
}

function normalizeOccurredAt(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const numericValue = typeof value === "number" || /^\d+$/.test(value) ? Number(value) * 1000 : NaN;
  const date = Number.isFinite(numericValue) ? new Date(numericValue) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePricing(value: unknown): NormalizedWhatsAppStatus["pricing"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pricing = value as Record<string, unknown>;
  const normalized: NonNullable<NormalizedWhatsAppStatus["pricing"]> = {};
  if (typeof pricing.billable === "boolean") normalized.billable = pricing.billable;
  if (typeof pricing.category === "string" && pricing.category.length <= 64) normalized.category = pricing.category;
  if (typeof pricing.pricing_model === "string" && pricing.pricing_model.length <= 64) normalized.model = pricing.pricing_model;
  return Object.keys(normalized).length ? normalized : undefined;
}

function observedResponse(
  body: BodyInit,
  init: ResponseInit & { status: WhatsAppIngressObservation["statusCode"] },
  startedAt: number,
  observation: Pick<WhatsAppIngressObservation, "outcome" | "reason">,
): Response {
  recordWhatsAppIngressTelemetry({
    ...observation,
    statusCode: init.status,
    durationMs: performance.now() - startedAt,
  });

  return new Response(body, init);
}

async function handleInboundMessage({
  phoneNumberId,
  message,
}: {
  phoneNumberId: string;
  message: any;
}) {
  const event: WhatsAppInboundEvent = {
    provider: "whatsapp",

    providerMessageId: message.id,

    phoneNumberId,

    customerAddress: message.from,

    timestamp: Number(message.timestamp),

    type: normalizeMessageType(message.type),

    text: message.type === "text" ? (message.text?.body ?? null) : null,
  };

  console.log("WhatsApp inbound message", {
    providerMessageId: event.providerMessageId,
    type: event.type,
    phoneNumberId: event.phoneNumberId,
  });

  const jobId = createJobId(event.providerMessageId);

  const whatsappQueue = getWhatsAppQueue();

  await whatsappQueue.add("message-received", event, {
    jobId,

    attempts: 3,

    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

function getWhatsAppVerifyToken(): string {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!token) {
    throw new Error("WHATSAPP_VERIFY_TOKEN is required");
  }

  return token;
}

function verifyMetaSignature(request: Request, rawBody: string): boolean {
  const signature = request.headers.get("x-hub-signature-256");

  if (!signature) {
    return false;
  }

  const appSecret = getMetaAppSecret();

  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", appSecret)
      .update(rawBody, "utf8")
      .digest("hex");

  const received = Buffer.from(signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

function getMetaAppSecret(): string {
  const secret = process.env.META_APP_SECRET;

  if (!secret) {
    throw new Error("META_APP_SECRET is required");
  }

  return secret;
}

function createJobId(providerMessageId: string): string {
  return (
    "wa-" + crypto.createHash("sha256").update(providerMessageId).digest("hex")
  );
}

export function createStatusJobId(event: NormalizedWhatsAppStatus): string {
  return (
    "ws-" + crypto.createHash("sha256")
      .update(`${event.providerAccountId}:${event.providerPhoneNumberId}:${event.providerMessageId}:${event.status}`)
      .digest("hex").slice(0, 61)
  );
}

function normalizeMessageType(type: string): WhatsAppMessageType {
  switch (type) {
    case "text":
    case "image":
    case "audio":
    case "document":
    case "interactive":
      return type;

    default:
      return "unknown";
  }
}
