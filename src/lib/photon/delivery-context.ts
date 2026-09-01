import { AsyncLocalStorage } from "node:async_hooks";

export type PhotonDeliveryContext = {
  webhookId: string;
  criticalTasks?: Promise<unknown>[];
  continuations?: Promise<unknown>[];
  processingFailed?: boolean;
};

const storage = new AsyncLocalStorage<PhotonDeliveryContext>();

export function getPhotonDeliveryContext(): PhotonDeliveryContext | undefined {
  return storage.getStore();
}

export function runWithPhotonDeliveryContext<T>(
  context: PhotonDeliveryContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function registerPhotonCriticalTask(task: Promise<unknown>): void {
  storage.getStore()?.criticalTasks?.push(task);
}

export function registerPhotonContinuation(task: Promise<unknown>): boolean {
  const continuations = storage.getStore()?.continuations;
  if (!continuations) return false;
  continuations.push(task);
  return true;
}

export function markPhotonProcessingFailure(): void {
  const context = storage.getStore();
  if (context) context.processingFailed = true;
}
