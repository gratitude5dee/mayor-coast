import { adminIdentityFromEncryptedThreadRef, type AdminUserIdentity } from "@/lib/admin-identities";

export function adminUserView<T extends { encryptedThreadRef: string | null }>(value: T, serviceSecret: string) {
  const { encryptedThreadRef, ...user } = value;
  return { ...user, ...adminIdentityFromEncryptedThreadRef(encryptedThreadRef, serviceSecret) } satisfies Omit<T, "encryptedThreadRef"> & AdminUserIdentity;
}
