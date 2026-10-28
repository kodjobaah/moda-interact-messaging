import crypto from "node:crypto";

// Server-only Meta authentication. Keep HTTP responses and request handling in the route.
export function hasSyntacticallyValidMetaSignature(request: Request): boolean {
  const signature = request.headers.get("x-hub-signature-256");
  return typeof signature === "string" && /^sha256=[a-f0-9]{64}$/.test(signature);
}

export function verifyMetaSignature(
  request: Request,
  rawBody: string,
  appSecret: string,
): boolean {
  const signature = request.headers.get("x-hub-signature-256");
  if (!hasSyntacticallyValidMetaSignature(request) || !signature) return false;

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
