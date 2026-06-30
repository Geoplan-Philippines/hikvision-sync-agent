type AuthenticationHaltedListener = (reason: string) => void;

let haltedReason: string | null = null;
const listeners = new Set<AuthenticationHaltedListener>();

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

export function onHikvisionAuthenticationHalted(
  listener: AuthenticationHaltedListener,
): () => void {
  listeners.add(listener);
  if (haltedReason !== null) listener(haltedReason);
  return () => listeners.delete(listener);
}
