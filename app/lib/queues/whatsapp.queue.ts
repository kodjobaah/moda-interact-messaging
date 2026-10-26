import { Queue } from "bullmq";
import { META_TEMPLATE_STATUS_QUEUE } from "@modainteract/moda-interact-shared/whatsapp-template-events";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { getRedis } from "../redis/redis";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-interact-messaging",
});

let whatsappQueue: Queue | null = null;

export function getWhatsAppQueue() {
  if (whatsappQueue) {
    return whatsappQueue;
  }

  whatsappQueue = new Queue(
    META_TEMPLATE_STATUS_QUEUE,
    {
      connection: getRedis(),
      telemetry: bullMQTelemetry,

      defaultJobOptions: {
        attempts: 3,

        backoff: {
          type: "exponential",
          delay: 1000,
        },

        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    },
  );

  return whatsappQueue;
}