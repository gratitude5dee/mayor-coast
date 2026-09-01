import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function normalizeSenderAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!normalized) throw new Error("Sender address is empty");

  if (normalized.startsWith("+")) {
    const digits = normalized.slice(1).replace(/[^0-9]/g, "");
    if (digits.length < 8 || digits.length > 15) {
      throw new Error("Sender phone address is invalid");
    }
    return `+${digits}`;
  }

  if (normalized.includes("@") && normalized.length <= 254) return normalized;
  throw new Error("Sender address is invalid");
}

export function pseudonymizeSender(address: string, pepper: string): string {
  if (pepper.length < 32) throw new Error("Identity pepper is too short");
  return createHmac("sha256", pepper)
    .update(normalizeSenderAddress(address), "utf8")
    .digest("hex");
}

export function pseudonymizeOpaqueIdentifier(
  value: string,
  pepper: string,
  namespace: string,
): string {
  if (pepper.length < 32) throw new Error("Identity pepper is too short");
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096) {
    throw new Error("Opaque identifier is invalid");
  }
  return createHmac("sha256", pepper)
    .update(`${namespace}\0${normalized}`, "utf8")
    .digest("hex");
}

function threadReferenceKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("Service secret is too short");
  return createHash("sha256")
    .update("coast:photon-thread-reference:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

/**
 * Photon thread IDs contain the sender address. Convex receives only this
 * authenticated ciphertext; the plaintext exists solely at the Vercel edge.
 */
export function encryptThreadReference(threadId: string, secret: string): string {
  const plaintext = threadId.trim();
  if (!plaintext || plaintext.length > 4_096) {
    throw new Error("Thread reference is invalid");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", threadReferenceKey(secret), iv);
  cipher.setAAD(Buffer.from("coast-thread-reference-v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptThreadReference(value: string, secret: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra !== undefined
  ) {
    throw new Error("Encrypted thread reference is malformed");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      threadReferenceKey(secret),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(Buffer.from("coast-thread-reference-v1", "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    if (!plaintext || plaintext.length > 4_096) throw new Error("invalid plaintext");
    return plaintext;
  } catch {
    throw new Error("Encrypted thread reference could not be authenticated");
  }
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
