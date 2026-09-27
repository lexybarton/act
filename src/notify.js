// Opt-in "your turn" pings through ntfy (https://ntfy.sh or a self-hosted NTFY_URL).
// Only a generic message is sent, never any session content.
const BASE = (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

export const validTopic = (t) => /^[A-Za-z0-9_-]{8,64}$/.test(t);

const lastTurn = new Map(); // `${sessionId}:${p}` -> boolean

// Ping each participant whose turn has just begun.
export function update(s, turnOf) {
  for (const p of ["A", "B"]) {
    const part = s.participants[p];
    if (!part) continue;
    const key = `${s.id}:${p}`;
    const turn = !!turnOf(s, p);
    const was = lastTurn.get(key);
    lastTurn.set(key, turn);
    if (!turn || was || !part.notify) continue;
    fetch(`${BASE}/${part.notify}`, {
      method: "POST",
      headers: { Title: "Act", Tags: "handshake", ...(PUBLIC_URL ? { Click: `${PUBLIC_URL}/#/s/${s.id}` } : {}) },
      body: "It's your turn in Act.",
    }).catch((err) => console.error(`[notify] ${err.message}`));
  }
}

export function forget(id) {
  for (const p of ["A", "B"]) lastTurn.delete(`${id}:${p}`);
}
