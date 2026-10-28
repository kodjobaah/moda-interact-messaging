import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  recordWhatsAppIngressTelemetry,
  type WhatsAppIngressObservation,
} from "~/lib/observability/whatsapp-ingress-telemetry";
import { dispatchWhatsAppWebhook } from "~/lib/whatsapp/webhook-dispatch.server";
import {
  hasSyntacticallyValidMetaSignature,
  verifyMetaSignature,
} from "~/lib/whatsapp/webhook-auth.server";
import {
  MetaConfigurationFailure,
  type MetaCredentialsSnapshot,
  type MetaWebhookCredentialsReader,
} from "~/lib/platform-configuration/meta-contract.server";
import { getProductionMetaWebhookCredentialsReader } from "~/lib/platform-configuration/meta-production.server";

/**
 * Meta webhook verification.
 *
 * GET /webhook/whatsapp
 */
export async function loader(
  { request }: LoaderFunctionArgs,
  injectedReader?: MetaWebhookCredentialsReader,
) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new Response("Forbidden", { status: 403 });
  }

  let snapshot: MetaCredentialsSnapshot;
  try {
    const reader = injectedReader ?? getProductionMetaWebhookCredentialsReader();
    snapshot = await reader.read();
  } catch (error) {
    if (error instanceof MetaConfigurationFailure) {
      return new Response("Service Unavailable", { status: 503 });
    }
    throw error;
  }

  if (token === snapshot.value.verifyToken) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }

  return new Response("Forbidden", {
    status: 403,
  });
}

/**
 * Actual WhatsApp webhook.
 *
 * POST /webhook/whatsapp
 */
// The optional dispatcher is a test seam. React Router supplies only its normal
// action arguments, so production always uses the existing event dispatcher.
export async function action(
  { request }: ActionFunctionArgs,
  dispatch: typeof dispatchWhatsAppWebhook = dispatchWhatsAppWebhook,
  injectedReader?: MetaWebhookCredentialsReader,
): Promise<Response> {
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

    if (!hasSyntacticallyValidMetaSignature(request)) {
      return observedResponse(
        "Unauthorized",
        { status: 401 },
        startedAt,
        { outcome: "rejected", reason: "invalid_signature" },
      );
    }

    let snapshot: MetaCredentialsSnapshot;
    try {
      const reader = injectedReader ?? getProductionMetaWebhookCredentialsReader();
      snapshot = await reader.read();
    } catch (error) {
      if (error instanceof MetaConfigurationFailure) {
        return observedResponse(
          "Service Unavailable",
          { status: 503 },
          startedAt,
          { outcome: "failed", reason: "configuration_unavailable" },
        );
      }
      throw error;
    }

    if (!verifyMetaSignature(request, rawBody, snapshot.value.appSecret)) {
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

    const outcome = await dispatch(payload);
    if (outcome === "invalid_payload") {
      return observedResponse(
        "Bad Request",
        { status: 400 },
        startedAt,
        { outcome: "rejected", reason: "invalid_payload" },
      );
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
