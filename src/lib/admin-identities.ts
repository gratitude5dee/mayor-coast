import { decryptThreadReference, normalizeSenderAddress } from "@/lib/security/identity";

export type AdminUserIdentity = {
  userAddress: string | null;
  userPhone: string | null;
  userEmail: string | null;
  photonLine: string | null;
  photonPhone: string | null;
};

export function adminIdentityFromEncryptedThreadRef(
  encryptedThreadRef: string | null,
  serviceSecret: string,
): AdminUserIdentity {
  const unavailable = {
    userAddress: null,
    userPhone: null,
    userEmail: null,
    photonLine: null,
    photonPhone: null,
  };
  if (encryptedThreadRef === null) return unavailable;
  try {
    const threadRef = decryptThreadReference(encryptedThreadRef, serviceSecret);
    if (!threadRef.startsWith("imessage:")) return unavailable;
    const encoded = threadRef.slice("imessage:".length);
    const separator = encoded.lastIndexOf("~");
    const chatGuid = separator === -1 ? encoded : encoded.slice(0, separator);
    const photonLine = separator === -1 ? null : encoded.slice(separator + 1).trim() || null;
    const parts = chatGuid.split(";");
    if (parts.length < 3 || parts.at(-2) !== "-") return unavailable;
    const userAddress = normalizeSenderAddress(parts.at(-1) ?? "");
    let photonPhone: string | null = null;
    if (photonLine?.startsWith("+")) {
      try { photonPhone = normalizeSenderAddress(photonLine); } catch { photonPhone = null; }
    }
    return {
      userAddress,
      userPhone: userAddress.startsWith("+") ? userAddress : null,
      userEmail: userAddress.includes("@") ? userAddress : null,
      photonLine,
      photonPhone,
    };
  } catch {
    return unavailable;
  }
}
