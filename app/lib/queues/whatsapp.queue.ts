import { Queue } from "bullmq";
import { getRedis } from "../redis/redis";


let whatsappQueue: Queue | null = null;

export function getWhatsAppQueue() {
  if (whatsappQueue) {
    return whatsappQueue;
  }

  whatsappQueue = new Queue(
    "whatsapp-events",
    {
      connection: getRedis(),

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