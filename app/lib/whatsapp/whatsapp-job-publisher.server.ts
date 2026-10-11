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
