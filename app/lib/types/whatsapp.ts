export type WhatsAppMessageType =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "interactive"
  | "unknown";

export interface WhatsAppInboundEvent {
  provider: "whatsapp";

  providerMessageId: string;
  phoneNumberId: string;

  customerAddress: string;

  timestamp: number;

  type: WhatsAppMessageType;

  text: string | null;
}