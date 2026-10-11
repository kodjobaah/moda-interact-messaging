import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  recordWhatsAppIngressTelemetry,
  type WhatsAppIngressObservation,
} from "~/lib/observability/whatsapp-ingress-telemetry";
import { normalizeInboundMessageFromWebhook } from "~/lib/whatsapp/inbound-message-normalizer";
import { normalizeProviderStatusFromWebhook } from "~/lib/whatsapp/provider-status-normalizer";
import { getWhatsAppVerifyToken, verifyMetaSignature } from "~/lib/whatsapp/webhook-auth.server";
import { enqueueInboundMessage, enqueueProviderStatus } from "~/lib/whatsapp/whatsapp-job-publisher.server";

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

  await enqueueProviderStatus(normalized);
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
