import crypto from "node:crypto";

import { WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION } from "@modainteract/moda-interact-shared/billing";
import type {
  NormalizedWhatsAppStatus,
} from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  recordWhatsAppIngressTelemetry,
  type WhatsAppIngressObservation,
} from "~/lib/observability/whatsapp-ingress-telemetry";
import { getWhatsAppQueue } from "~/lib/queues/whatsapp.queue";
import { normalizeInboundMessageFromWebhook } from "~/lib/whatsapp/inbound-message-normalizer";
import { normalizeProviderStatusFromWebhook } from "~/lib/whatsapp/provider-status-normalizer";
import { getWhatsAppVerifyToken, verifyMetaSignature } from "~/lib/whatsapp/webhook-auth.server";

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
        /*
         * Incoming customer messages
         */
        for (const message of value.messages ?? []) {
          const normalized = normalizeInboundMessageFromWebhook({
            entry,
            change,
            message,
          });

          if (!normalized) {
            return observedResponse(
              "Bad Request",
              { status: 400 },
              startedAt,
              { outcome: "rejected", reason: "invalid_payload" },
            );
          }

          await enqueueInboundMessage(normalized);
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

async function enqueueInboundMessage(event: NormalizedWhatsAppInboundMessage) {

  console.log("WhatsApp inbound message", {
    providerMessageId: event.providerMessageId,
    type: event.content.type,
    providerPhoneNumberId: event.providerPhoneNumberId,
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
export function createJobId(providerMessageId: string): string {
  return (
    "wa-" + crypto.createHash("sha256").update(providerMessageId).digest("hex")
  );
}

export function createStatusJobId(event: NormalizedWhatsAppStatus): string {
  const identity = `${event.providerAccountId}:${event.providerPhoneNumberId}:${event.providerMessageId}:${event.status}`;
  const failureEvidence = event.schemaVersion === WHATSAPP_PROVIDER_STATUS_SCHEMA_VERSION
    && event.status === "FAILED"
    ? event.failure?.providerCode
    : undefined;

  return (
    "ws-" + crypto.createHash("sha256")
      .update(failureEvidence ? `${identity}:failure:${failureEvidence}` : identity)
      .digest("hex").slice(0, 61)
  );
}
