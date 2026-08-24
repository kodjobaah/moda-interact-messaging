import crypto from "node:crypto";

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

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
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "POST",
      },
    });
  }

  const rawBody = await request.text();
  console.log("WhatsApp webhook received", {
    rawBody,
  });

  if (!verifyMetaSignature(request, rawBody)) {
    console.error("Invalid Meta webhook signature");

    return new Response("Unauthorized", {
      status: 401,
    });
  }

  let payload: any;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("Invalid WhatsApp webhook JSON");

    return new Response("Bad Request", {
      status: 400,
    });
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
        console.log("WhatsApp message status", {
          messageId: status.id,
          status: status.status,
        });
      }
    }
  }


  return new Response("EVENT_RECEIVED", {
    status: 200,
  });
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
