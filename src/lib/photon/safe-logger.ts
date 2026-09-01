import type { Logger } from "chat";

import { markPhotonProcessingFailure } from "./delivery-context";

/**
 * The messaging SDK can attach provider payloads to log arguments. COAST logs
 * only the SDK's static event text and intentionally discards all arguments,
 * preventing phone numbers, message bodies, and credentials from reaching
 * Vercel logs.
 */
export class PhotonSafeLogger implements Logger {
  constructor(
    private readonly prefix = "photon",
    private readonly sink: Pick<Console, "debug" | "error" | "info" | "warn"> =
      console,
  ) {}

  child(prefix: string): Logger {
    return new PhotonSafeLogger(`${this.prefix}:${safeLabel(prefix)}`, this.sink);
  }

  debug(message: string, ..._providerArguments: unknown[]): void {
    void _providerArguments;
    this.sink.debug(this.format(message));
  }

  error(message: string, ..._providerArguments: unknown[]): void {
    void _providerArguments;
    if (message === "Message processing error") markPhotonProcessingFailure();
    this.sink.error(this.format(message));
  }

  info(message: string, ..._providerArguments: unknown[]): void {
    void _providerArguments;
    this.sink.info(this.format(message));
  }

  warn(message: string, ..._providerArguments: unknown[]): void {
    void _providerArguments;
    this.sink.warn(this.format(message));
  }

  private format(message: string): string {
    return `[${this.prefix}] ${safeMessage(message)}`;
  }
}

function safeLabel(value: string): string {
  if (SENSITIVE_TEXT.test(value)) return "child";
  return value.replace(/[^a-z0-9:_-]/gi, "_").slice(0, 64);
}

function safeMessage(value: string): string {
  // The Logger contract does not prove that its first argument is static.
  // Therefore only known generic SDK event names are emitted; an arbitrary
  // short message body such as "dinner tonight" is redacted as well.
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  if (SENSITIVE_TEXT.test(normalized) || !SAFE_PROVIDER_EVENTS.has(normalized)) {
    return "redacted provider event";
  }
  return normalized;
}

const SENSITIVE_TEXT =
  /(?:\+?\d[\d ().-]{7,}|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|https?:\/\/|\{[\s\S]*\}|secret|token|authorization)/i;

/**
 * Generic first-argument strings used by chat@4 and the pinned iMessage
 * adapter. Dynamic diagnostic details are supplied as later arguments, which
 * PhotonSafeLogger always discards.
 */
const SAFE_PROVIDER_EVENTS = new Set([
  "Adapter disconnect failed",
  "Adapter disconnected",
  "Adapter initialized",
  "Chat instance created",
  "Chat instance initialized",
  "Chat instance shut down",
  "Could not acquire lock on thread",
  "Could not clear turn cancellation state",
  "Could not poll turn cancellation state",
  "Could not publish active turn for cancellation",
  "Could not rebuild Space from chat GUID",
  "Direct message received - calling handlers",
  "Disconnecting adapter",
  "Force-releasing lock on thread",
  "Incoming message",
  "Initializing adapter",
  "Initializing chat instance...",
  "Lock acquired",
  "Lock heartbeat failed",
  "Lock released",
  "Message processing error",
  "No handlers matched message",
  "Poll vote did not match a known modal, skipping",
  "Registered direct message handler",
  "Rejected iMessage webhook delivery",
  "Shutting down chat instance...",
  "Skipping duplicate message",
  "Skipping malformed inbound iMessage reaction",
  "Skipping message from self (isMe=true)",
  "Starting iMessage Gateway listener",
  "State connected",
  "Webhook received",
  "iMessage Gateway listener received abort signal",
  "iMessage Gateway listener stopped",
  "iMessage adapter initialized",
  "iMessage inbound handler error",
  "iMessage message stream error",
  "message-debouncing",
  "message-dequeued",
  "message-dropped",
  "message-expired",
  "message-superseded",
]);
