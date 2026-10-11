import crypto from "node:crypto";

// Server-only Meta authentication. Keep HTTP responses and request handling in the route.
export function getWhatsAppVerifyToken(): string {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!token) {
    throw new Error("WHATSAPP_VERIFY_TOKEN is required");
  }

  return token;
}

export function verifyMetaSignature(request: Request, rawBody: string): boolean {
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
