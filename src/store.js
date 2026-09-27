// In-memory session store with write-through JSON persistence (one file per session).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || "data");
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
fs.mkdirSync(DATA_DIR, { recursive: true });

const sessions = new Map();

for (const file of fs.readdirSync(DATA_DIR)) {
  if (!file.endsWith(".json")) continue;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
    // Jobs cannot survive a restart; surface them as retryable errors.
    for (const job of Object.values(s.jobs || {})) {
      if (job.status === "running") Object.assign(job, { status: "error", error: "Server restarted during processing. Please retry." });
    }
    sessions.set(s.id, s);
  } catch (e) {
    console.error(`Skipping unreadable session file ${file}: ${e.message}`);
  }
}

export const newId = (bytes = 12) => crypto.randomBytes(bytes).toString("base64url");

export function newJoinCode() {
  // Unambiguous alphabet; the code only claims the second seat once, then it is spent.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  } while ([...sessions.values()].some((s) => s.joinCode === code));
  return code;
}

export function get(id) {
  return sessions.get(id);
}

export function findByJoinCode(code) {
  return [...sessions.values()].find((s) => s.joinCode && s.joinCode === code);
}

export function save(s) {
  s.version = (s.version || 0) + 1;
  s.updatedAt = new Date().toISOString();
  sessions.set(s.id, s);
  const file = path.join(DATA_DIR, `${s.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return s;
}

export function remove(id) {
  sessions.delete(id);
  fs.rmSync(path.join(DATA_DIR, `${id}.json`), { force: true });
}

export function sweepExpired() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  for (const s of sessions.values()) {
    if (Date.parse(s.updatedAt) < cutoff) remove(s.id);
  }
}
