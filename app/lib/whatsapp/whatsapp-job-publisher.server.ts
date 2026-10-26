import {
  META_TEMPLATE_STATUS_JOB,
  MetaTemplateStatusObservationV2Schema,
  formatMetaTemplateStatusJobId,
} from "@modainteract/moda-interact-shared/whatsapp-template-events";
import type { MetaTemplateStatusObservationV2 } from "@modainteract/moda-interact-shared/whatsapp-template-events";

import type { NormalizedWhatsAppStatus } from "@modainteract/moda-interact-shared/billing";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

import { getWhatsAppQueue } from "~/lib/queues/whatsapp.queue";
import { createJobId, createStatusJobId } from "./job-identity.server";

// The optional queue is a narrow test seam; production always uses the existing
// BullMQ queue adapter, including its telemetry and connection ownership.
type WhatsAppQueueWriter = Pick<ReturnType<typeof getWhatsAppQueue>, "add">;

export async function enqueueInboundMessage(
  event: NormalizedWhatsAppInboundMessage,
  queue?: WhatsAppQueueWriter,
): Promise<void> {
  console.log("WhatsApp inbound message", {
    providerMessageId: event.providerMessageId,
    type: event.content.type,
    providerPhoneNumberId: event.providerPhoneNumberId,
  });

  const jobId = createJobId(event.providerMessageId);
  const whatsappQueue = queue ?? getWhatsAppQueue();

  await whatsappQueue.add("message-received", event, {
    jobId,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

export async function enqueueProviderStatus(
  event: NormalizedWhatsAppStatus,
  queue?: WhatsAppQueueWriter,
): Promise<void> {
  const whatsappQueue = queue ?? getWhatsAppQueue();
  await whatsappQueue.add("message-status", event, {
    jobId: createStatusJobId(event),
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

/** Enqueue a validated, per-occurrence Meta template status observation. */
export async function enqueueTemplateStatus(
  event: MetaTemplateStatusObservationV2,
  queue?: WhatsAppQueueWriter,
): Promise<void> {
  // Validate direct callers too; transport validation remains authoritative in Shared.
  const observation = MetaTemplateStatusObservationV2Schema.parse(event);
  const observationId = observation.eventIdentity.split(":")[2];
  const jobId = formatMetaTemplateStatusJobId(observationId);
  // Queue ownership, connection and telemetry remain in whatsapp.queue.ts.
  const whatsappQueue = queue ?? getWhatsAppQueue();
  const added = await whatsappQueue.add(META_TEMPLATE_STATUS_JOB, observation, {
    jobId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
  });
  if (!added || added.id !== jobId) {
    throw new Error("Meta template status job was not accepted with its expected identity");
  }
}
