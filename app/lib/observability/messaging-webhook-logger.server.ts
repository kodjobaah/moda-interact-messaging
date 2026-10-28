import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";

/**
 * Domain-specific access to the published Shared logger. All formatting,
 * redaction, error serialization and sink isolation remain owned by Shared.
 */
export type MessagingWebhookLogger = Pick<StructuredLogger, "info" | "warn" | "error">;

let webhookLogger: MessagingWebhookLogger | undefined;

export function getMessagingWebhookLogger(): MessagingWebhookLogger {
  webhookLogger ??= createLogger({
    serviceName: "moda-interact-messaging",
    environment: process.env.DEPLOYMENT_ENVIRONMENT_NAME || "local",
  });
  return webhookLogger;
}
