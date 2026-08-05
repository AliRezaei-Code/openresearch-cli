const READ_SESSIONS_KEY = "orx:demo-read-sessions";

export function loadReadDemoSessions(): Set<string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(READ_SESSIONS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function markDemoSessionRead(sessionId: string): void {
  try {
    const read = loadReadDemoSessions();
    read.add(sessionId);
    sessionStorage.setItem(READ_SESSIONS_KEY, JSON.stringify([...read]));
  } catch {
    // Read state remains correct in memory when session storage is unavailable.
  }
}

export function clearReadDemoSessions(): void {
  try {
    sessionStorage.removeItem(READ_SESSIONS_KEY);
  } catch {
    // A fresh in-memory state is already used when session storage is unavailable.
  }
}
