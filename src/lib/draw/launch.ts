export function drawLaunchSecret(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const secret = new URLSearchParams(value).get("secret")?.trim();
  return secret && secret.length >= 20 && secret.length <= 256 ? secret : null;
}

export function drawSessionCookie(name: string, token: string, maxAgeSeconds: number): string {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
