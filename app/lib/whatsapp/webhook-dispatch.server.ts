import {
  enqueueInboundMessage,
  enqueueProviderStatus,
  enqueueTemplateStatus,
} from "./whatsapp-job-publisher.server";
import { createTemplateStatusObservation } from "./template-status-observation-id.server";
import { preflightWhatsAppWebhook } from "./webhook-preflight";
import {
  getMessagingWebhookLogger,
  type MessagingWebhookLogger,
} from "~/lib/observability/messaging-webhook-logger.server";

export type WhatsAppDispatchOutcome = "accepted" | "invalid_payload";

type WhatsAppPublishers = {
  enqueueInboundMessage: typeof enqueueInboundMessage;
  enqueueProviderStatus: typeof enqueueProviderStatus;
  enqueueTemplateStatus: typeof enqueueTemplateStatus;
};

const productionPublishers: WhatsAppPublishers = {
  enqueueInboundMessage,
  enqueueProviderStatus,
  enqueueTemplateStatus,
};

// Only permit bounded, explicitly recognised Meta field names into diagnostics.
// Unknown/untrusted field names and all field values are never logged.
const RECOGNISED_FIELDS = new Set([
  "messages",
  "message_template_status_update",
  "message_echoes",
  "message_template_components_update",
  "message_template_quality_update",
  "messaging_handovers",
  "template_category_update",
  "template_correct_category_detection",
]);
const UNSUPPORTED_FIELDS = new Set([
  "message_echoes",
  "message_template_components_update",
  "message_template_quality_update",
  "messaging_handovers",
  "template_category_update",
  "template_correct_category_detection",
]);

function summarizeFields(payload: unknown) {
  const received = new Set<string>();
  const ignored = new Set<string>();
  let unknownFieldCount = 0;

  // Preflight already checked this shape. The defensive guard also means this
  // function cannot expose unvalidated payload values if called independently.
  if (typeof payload !== "object" || payload === null || !("entry" in payload) ||
      !Array.isArray(payload.entry)) {
    return { receivedFields: [], ignoredFields: [], unknownFieldCount };
  }

  for (const entry of payload.entry) {
    if (typeof entry !== "object" || entry === null || !("changes" in entry) ||
        !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const field = typeof change === "object" && change !== null && "field" in change
        ? change.field
        : undefined;
      if (typeof field !== "string" || !RECOGNISED_FIELDS.has(field)) {
        unknownFieldCount += 1;
        continue;
      }
      received.add(field);
      if (UNSUPPORTED_FIELDS.has(field) ||
          (field === "message_template_status_update" &&
           ("object" in payload ? payload.object : undefined) !== "whatsapp_business_account")) {
        ignored.add(field);
      }
    }
  }

  return {
    receivedFields: [...received].sort(),
    ignoredFields: [...ignored].sort(),
    unknownFieldCount,
  };
}

export async function dispatchWhatsAppWebhook(
  payload: unknown,
  publishers: WhatsAppPublishers = productionPublishers,
  injectedLogger?: MessagingWebhookLogger,
): Promise<WhatsAppDispatchOutcome> {
  const logger = injectedLogger ?? getMessagingWebhookLogger();
  const prepared = preflightWhatsAppWebhook(payload);
  if (!prepared.valid) {
    logger.warn("messaging.webhook.dispatch_rejected", {
      reasonCode: "INVALID_PAYLOAD",
      publishedCount: 0,
    });
    return "invalid_payload";
  }

  const fields = summarizeFields(payload);
  const normalizedCounts = { inbound: 0, status: 0, templateStatus: 0 };
  for (const item of prepared.events) {
    if (item.kind === "inbound") normalizedCounts.inbound += 1;
    else if (item.kind === "status") normalizedCounts.status += 1;
    else normalizedCounts.templateStatus += 1;
  }

  let publishedCount = 0;
  // Only begin side effects after the whole authenticated batch passes preflight.
  // Publication remains sequential and is not a multi-job atomic transaction.
  for (const item of prepared.events) {
    let failurePhase: "QUEUE_PUBLICATION" | "OBSERVATION_CREATION" = "QUEUE_PUBLICATION";
    try {
      if (item.kind === "inbound") {
        await publishers.enqueueInboundMessage(item.event);
      } else if (item.kind === "status") {
        await publishers.enqueueProviderStatus(item.event);
      } else {
        failurePhase = "OBSERVATION_CREATION";
        const observation = createTemplateStatusObservation(item.event);
        failurePhase = "QUEUE_PUBLICATION";
        await publishers.enqueueTemplateStatus(observation);
      }
      publishedCount += 1;
    } catch (error) {
      logger.error("messaging.webhook.dispatch_failed", {
        ...fields,
        normalizedCounts,
        publishedCount,
        failedKind: item.kind,
        reasonCode: failurePhase === "QUEUE_PUBLICATION"
          ? "QUEUE_PUBLICATION_FAILED"
          : "TEMPLATE_OBSERVATION_FAILED",
      });
      // Preserve the original error: a partial batch must never be acknowledged.
      throw error;
    }
  }

  logger.info("messaging.webhook.dispatch_completed", {
    ...fields,
    normalizedCounts,
    publishedCount,
    outcome: publishedCount > 0
      ? "published"
      : fields.ignoredFields.length > 0 || fields.unknownFieldCount > 0
        ? "ignored"
        : "no_actionable_events",
  });

  return "accepted";
}
