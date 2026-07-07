type AuthenticationHaltedListener = (reason: string) => void;
type AuthenticationResumedListener = () => void;

let haltedReason: string | null = null;
const listeners = new Set<AuthenticationHaltedListener>();
const resumedListeners = new Set<AuthenticationResumedListener>();

export function isHikvisionAuthenticationHalted(): boolean {
  return haltedReason !== null;
}

export function hikvisionAuthenticationHaltedReason(): string | null {
  return haltedReason;
}

export function haltHikvisionAuthentication(reason: string): void {
  if (haltedReason !== null) return;
  haltedReason = reason;
  for (const listener of listeners) listener(reason);
}

/** Clears a previous authentication halt so the listener and sync client can retry. */
export function resetHikvisionAuthentication(): void {
  if (haltedReason === null) return;
  haltedReason = null;
  for (const listener of resumedListeners) listener();
}

export function onHikvisionAuthenticationHalted(
  listener: AuthenticationHaltedListener,
): () => void {
  listeners.add(listener);
  if (haltedReason !== null) listener(haltedReason);
  return () => listeners.delete(listener);
}

export function onHikvisionAuthenticationResumed(
  listener: AuthenticationResumedListener,
): () => void {
  resumedListeners.add(listener);
  return () => resumedListeners.delete(listener);
}
