// Session model, state machine, background jobs and the per-participant (privacy-filtered) view.
import * as store from "./store.js";
import * as llm from "./llm.js";

export const STATES = [
  "CREATED",
  "PRIVATE_INTAKE",
  "INTAKE_CONFIRMED",
  "SHARED_MAP_PROPOSED",
  "SHARED_MAP_CONFIRMED",
  "OPTIONS_GENERATED",
  "SINGLE_TEXT_REVISION",
  "FULL_AGREEMENT",
  "PARTIAL_AGREEMENT",
  "CLARIFIED_DISAGREEMENT",
  "NO_AGREEMENT",
];
export const TERMINAL = ["FULL_AGREEMENT", "PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT", "NO_AGREEMENT"];
export const VOTES = ["accept", "accept_with_revision", "uncertain", "reject", "not_important"];
export const SHARING = ["verbatim", "paraphrase", "private"];
export const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 8);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 409) => {
  throw new HttpError(status, message);
};
const other = (p) => (p === "A" ? "B" : "A");
const now = () => new Date().toISOString();

function newParticipant(name) {
  return {
    name,
    token: store.newId(24),
    joinedAt: now(),
    intake: Object.fromEntries(llm.INTAKE_FIELDS.map((f) => [f, ""])),
    // Per-field sharing default: interests are the core of the process, alternatives are usually private.
    sharing: Object.fromEntries(llm.INTAKE_FIELDS.map((f) => [f, f === "alternatives" ? "private" : "paraphrase"])),
    intakeStatus: "draft", // draft -> extracted -> confirmed
    statements: [],
    clarifyingQuestions: [],
    safety: null,
    batnaCheck: null,
  };
}

export function createSession({ title, name }) {
  const s = {
    id: store.newId(),
    joinCode: store.newJoinCode(),
    title,
    createdAt: now(),
    state: "CREATED",
    paused: null, // { by, at, reason }
    participants: { A: newParticipant(name), B: null },
    map: null, // { problemStatement, items: [], done: {A,B} }
    options: null, // { items: [] }
    draft: null, // { versions: [], feedback: {A,B}, improvable, sourceOptionIds }
    outcome: null, // { proposal: {type, by, at, note}, final: {type, at, by} }
    jobs: {},
    log: [],
  };
  log(s, "A", "created the session");
  return store.save(s);
}

export function join(code, name) {
  const s = store.findByJoinCode(code);
  if (!s) fail("Unknown or already used code.", 404);
  s.participants.B = newParticipant(name);
  s.joinCode = null; // one-time
  s.state = "PRIVATE_INTAKE";
  log(s, "B", "joined");
  store.save(s);
  return { id: s.id, token: s.participants.B.token };
}

export function auth(id, token) {
  const s = store.get(id);
  if (!s) fail("Session not found.", 404);
  const who = ["A", "B"].find((p) => s.participants[p]?.token && s.participants[p].token === token);
  if (!who) fail("Not a participant of this session.", 403);
  // Work on a copy: a handler that throws halfway must not leave half-applied changes in memory.
  return { s: structuredClone(s), who };
}

function log(s, who, text) {
  s.log.push({ at: now(), who, text });
}

function assertActive(s) {
  if (TERMINAL.includes(s.state)) fail("This process has ended.");
  if (s.paused) fail("The process is paused. Resume it first.");
}
function assertState(s, ...states) {
  assertActive(s);
  if (!states.includes(s.state)) fail(`Not possible in state ${s.state}.`);
}
function assertNoJob(s, key) {
  if (s.jobs[key]?.status === "running") fail("Already processing, please wait.");
}

// Background LLM job: the handler returns immediately, the client polls for the result.
function runJob(s, key, work, apply) {
  s.jobs[key] = { status: "running", startedAt: now() };
  store.save(s);
  work()
    .then((result) => {
      const cur = store.get(s.id);
      if (!cur) return; // deleted meanwhile
      apply(cur, result);
      cur.jobs[key] = { status: "done", at: now() };
      store.save(cur);
    })
    .catch((err) => {
      console.error(`[job ${key}]`, err);
      const cur = store.get(s.id);
      if (!cur) return;
      cur.jobs[key] = { status: "error", error: err.message || String(err), at: now() };
      store.save(cur);
    });
}

// Only confirmed, non-private statements ever reach prompts that produce shared output.
function sharedStatements(s, p) {
  return s.participants[p].statements.filter((st) => st.sharing !== "private");
}
const names = (s) => ({ A: s.participants.A.name, B: s.participants.B.name });

// ---------- Intake ----------

export function saveIntake(s, who, { intake, sharing }) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  if (me.intakeStatus === "confirmed") fail("Your intake is confirmed. Reopen it to edit.");
  for (const f of llm.INTAKE_FIELDS) {
    if (typeof intake?.[f] === "string") me.intake[f] = intake[f].slice(0, 8000);
    if (SHARING.includes(sharing?.[f])) me.sharing[f] = sharing[f];
  }
  return store.save(s);
}

export function submitIntake(s, who) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  if (me.intakeStatus === "confirmed") fail("Already confirmed.");
  for (const f of ["object", "position", "interests"]) {
    if (!me.intake[f].trim()) fail(`Please fill in at least: object, position and interests (missing: ${f}).`, 400);
  }
  const key = `extract_${who}`;
  assertNoJob(s, key);
  const input = { title: s.title, name: me.name, intake: { ...me.intake } };
  runJob(s, key, () => llm.extract(input), (cur, out) => {
    const p = cur.participants[who];
    p.statements = out.statements.map((st, i) => ({
      id: `${who}${i + 1}`,
      category: st.category,
      text: st.text,
      source: st.source_field,
      sharing: p.sharing[st.source_field] || "paraphrase",
    }));
    p.clarifyingQuestions = out.clarifying_questions;
    p.safety = out.safety.concern ? out.safety.note : null;
    p.intakeStatus = "extracted";
    log(cur, who, "received the structured extraction of their intake");
  });
  return s;
}

export function saveStatements(s, who, statements) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  if (me.intakeStatus !== "extracted") fail("Nothing to edit right now.");
  if (!Array.isArray(statements)) fail("Invalid statements.", 400);
  let next = Math.max(0, ...me.statements.map((st) => Number(st.id.slice(1)))) + 1;
  me.statements = statements
    .filter((st) => st && typeof st.text === "string" && st.text.trim())
    .map((st) => ({
      id: /^[AB]\d+$/.test(st.id || "") && st.id[0] === who ? st.id : `${who}${next++}`,
      category: llm.STATEMENT_CATEGORIES.includes(st.category) ? st.category : "claimed_fact",
      text: st.text.trim().slice(0, 2000),
      source: llm.INTAKE_FIELDS.includes(st.source) ? st.source : "observations",
      sharing: SHARING.includes(st.sharing) ? st.sharing : "paraphrase",
    }));
  return store.save(s);
}

export function confirmStatements(s, who) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  if (me.intakeStatus !== "extracted") fail("Nothing to confirm.");
  if (!me.statements.length) fail("Add at least one statement.", 400);
  if (!s.participants.B) fail("Wait until the other participant has joined.");
  me.intakeStatus = "confirmed";
  log(s, who, "confirmed their statements");
  if (s.participants[other(who)].intakeStatus === "confirmed") {
    s.state = "INTAKE_CONFIRMED";
    log(s, null, "both intakes confirmed");
    return generateMap(s, who);
  }
  return store.save(s);
}

export function reopenIntake(s, who) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  me.intakeStatus = "draft";
  log(s, who, "reopened their intake");
  return store.save(s);
}

// ---------- Shared map ----------

export function generateMap(s, who) {
  assertState(s, "INTAKE_CONFIRMED", "SHARED_MAP_PROPOSED");
  assertNoJob(s, "map");
  const input = { title: s.title, names: names(s), a: sharedStatements(s, "A"), b: sharedStatements(s, "B") };
  const validRefs = new Set([...input.a, ...input.b].map((st) => st.id));
  if (s.state === "SHARED_MAP_PROPOSED") log(s, who, "regenerated the problem map (all votes reset)");
  runJob(s, "map", () => llm.buildMap(input), (cur, out) => {
    cur.map = {
      problemStatement: out.problem_statement,
      items: out.items.map((it, i) => ({
        id: `M${i + 1}`,
        area: it.area,
        text: it.text,
        refs: it.refs.filter((r) => validRefs.has(r)),
        origin: "ai",
        votes: { A: null, B: null },
      })),
      done: { A: false, B: false },
    };
    cur.state = "SHARED_MAP_PROPOSED";
    log(cur, null, "shared problem map proposed");
  });
  return s;
}

export function voteMap(s, who, { itemId, vote, revision }) {
  assertState(s, "SHARED_MAP_PROPOSED");
  if (!VOTES.includes(vote)) fail("Invalid vote.", 400);
  const item = s.map.items.find((i) => i.id === itemId);
  if (!item) fail("Unknown item.", 404);
  if (item.superseded) fail("This item was replaced by a revision.");
  item.votes[who] = { vote, at: now() };
  if (vote === "accept_with_revision") {
    const text = (revision || "").trim();
    if (!text) fail("Please write your revised wording.", 400);
    item.votes[who].revision = text;
    // The revision is a new candidate: the author accepts it, the other side must vote on it.
    const rev = {
      id: `M${s.map.items.length + 1}`,
      area: item.area,
      text: text.slice(0, 2000),
      refs: item.refs,
      origin: who,
      revisionOf: item.id,
      votes: { [who]: { vote: "accept", at: now() }, [other(who)]: null },
    };
    s.map.items.push(rev);
    s.map.done[other(who)] = false;
    log(s, who, `proposed a revision of ${item.id}`);
  }
  s.map.done[who] = false;
  return store.save(s);
}

export function addMapItem(s, who, { area, text }) {
  assertState(s, "SHARED_MAP_PROPOSED");
  if (!llm.MAP_AREAS.includes(area) || !text?.trim()) fail("Area and text are required.", 400);
  s.map.items.push({
    id: `M${s.map.items.length + 1}`,
    area,
    text: text.trim().slice(0, 2000),
    refs: [],
    origin: who,
    votes: { [who]: { vote: "accept", at: now() }, [other(who)]: null },
  });
  s.map.done[other(who)] = false;
  log(s, who, "added an item to the problem map");
  return store.save(s);
}

export const itemStatus = (item) => {
  const a = item.votes.A?.vote;
  const b = item.votes.B?.vote;
  if (a === "accept" && b === "accept") return "confirmed";
  if (a === "reject" || b === "reject") return "rejected";
  if (a === "not_important" && b === "not_important") return "set_aside";
  if (!a || !b) return "pending";
  return "not_agreed";
};

export function finishMapReview(s, who) {
  assertState(s, "SHARED_MAP_PROPOSED");
  const missing = s.map.items.filter((i) => !i.votes[who] && !isSuperseded(s, i));
  if (missing.length) fail(`Please respond to every item first (${missing.length} left).`, 400);
  s.map.done[who] = true;
  log(s, who, "finished reviewing the problem map");
  if (s.map.done[other(who)]) {
    s.state = "SHARED_MAP_CONFIRMED";
    log(s, null, "problem map confirmed");
    return generateOptions(s, who);
  }
  return store.save(s);
}

// An item whose revision both accepted is superseded by that revision.
const isSuperseded = (s, item) => s.map.items.some((r) => r.revisionOf === item.id && itemStatus(r) === "confirmed");

function mapForPrompt(s) {
  return s.map.items
    .filter((i) => !isSuperseded(s, i) && itemStatus(i) !== "rejected")
    .map((i) => ({ area: i.area, text: i.text, status: itemStatus(i) === "confirmed" ? "accepted by both" : "not accepted by both" }));
}

// ---------- Options ----------

export function generateOptions(s, who) {
  assertState(s, "SHARED_MAP_CONFIRMED", "OPTIONS_GENERATED");
  assertNoJob(s, "options");
  const input = {
    title: s.title,
    names: names(s),
    problemStatement: s.map.problemStatement,
    mapItems: mapForPrompt(s),
    a: sharedStatements(s, "A"),
    b: sharedStatements(s, "B"),
  };
  if (s.state === "OPTIONS_GENERATED") log(s, who, "asked for a fresh set of options");
  runJob(s, "options", () => llm.generateOptions(input), (cur, out) => {
    const prev = cur.options?.items || [];
    cur.options = {
      items: out.options.map((o, i) => ({
        id: `O${prev.length + i + 1}`,
        ...o,
        reactions: { A: null, B: null },
      })),
    };
    cur.state = "OPTIONS_GENERATED";
    log(cur, null, "options generated");
  });
  return s;
}

export function reactOption(s, who, { optionId, reaction }) {
  assertState(s, "OPTIONS_GENERATED");
  if (!["promising", "needs_work", "unacceptable"].includes(reaction)) fail("Invalid reaction.", 400);
  const o = s.options.items.find((x) => x.id === optionId);
  if (!o) fail("Unknown option.", 404);
  o.reactions[who] = reaction;
  return store.save(s);
}

export function startDraft(s, who, { optionIds }) {
  assertState(s, "OPTIONS_GENERATED");
  assertNoJob(s, "draft");
  const chosen = s.options.items.filter((o) => optionIds?.includes(o.id));
  if (!chosen.length) fail("Choose at least one option to build the draft from.", 400);
  const input = {
    title: s.title,
    names: names(s),
    problemStatement: s.map.problemStatement,
    mapItems: mapForPrompt(s),
    options: chosen,
    a: sharedStatements(s, "A"),
    b: sharedStatements(s, "B"),
  };
  log(s, who, `started the single-text draft from ${chosen.map((o) => o.id).join(", ")}`);
  runJob(s, "draft", () => llm.draftZero(input), (cur, out) => {
    cur.draft = { versions: [], feedback: { A: null, B: null }, improvable: true, sourceOptionIds: optionIds };
    pushVersion(cur, out, null, null);
    cur.state = "SINGLE_TEXT_REVISION";
  });
  return s;
}

function pushVersion(s, out, prev, bothOk) {
  let next = prev ? Math.max(0, ...s.draft.versions.flatMap((v) => v.clauses.map((c) => Number(c.id.slice(1))))) + 1 : 1;
  const prevById = new Map((prev?.clauses || []).map((c) => [c.id, c]));
  const clauses = out.clauses.map((c) => {
    const old = prevById.get(c.ref_id);
    const id = old ? old.id : `C${next++}`;
    let status = c.bracketed ? "bracketed" : "open";
    // A clause is agreed only when both explicitly OK'd it and its text did not change.
    if (old && bothOk?.has(old.id) && old.text === c.text && !c.bracketed) status = "agreed";
    return { id, text: c.text, status, bracketNote: c.bracketed ? c.bracket_note : "" };
  });
  const n = s.draft.versions.length;
  s.draft.versions.push({ n, at: now(), preamble: out.preamble, clauses, changeLog: out.change_log });
  s.draft.improvable = out.improvable;
  s.draft.feedback = { A: null, B: null };
  for (const p of ["A", "B"]) s.participants[p].batnaCheck = null;
  log(s, null, `draft version ${n} ready`);
}

const current = (s) => s.draft.versions.at(-1);

export function submitFeedback(s, who, { clauses, general }) {
  assertState(s, "SINGLE_TEXT_REVISION");
  assertNoJob(s, "revise");
  const v = current(s);
  const fb = { clauses: {}, general: (general || "").trim().slice(0, 4000), at: now() };
  for (const c of v.clauses) {
    const f = clauses?.[c.id];
    if (f?.verdict === "change") {
      if (!f.text?.trim()) fail(`Clause ${c.id}: describe what must change.`, 400);
      fb.clauses[c.id] = { verdict: "change", text: f.text.trim().slice(0, 2000) };
    } else if (f?.verdict === "ok") {
      fb.clauses[c.id] = { verdict: "ok" };
    } else {
      fail(`Please respond to every clause (missing ${c.id}).`, 400);
    }
  }
  s.draft.feedback[who] = fb;
  log(s, who, `responded to draft version ${v.n}`);
  const fo = s.draft.feedback[other(who)];
  if (!fo) return store.save(s);

  const bothOk = new Set(v.clauses.filter((c) => fb.clauses[c.id].verdict === "ok" && fo.clauses[c.id].verdict === "ok").map((c) => c.id));
  if (bothOk.size === v.clauses.length && !fb.general && !fo.general) {
    // Both accept every clause as written: that is the full agreement.
    for (const c of v.clauses) c.status = "agreed";
    return finish(s, "FULL_AGREEMENT", null);
  }
  if (s.draft.versions.length >= MAX_ROUNDS) {
    // Stop criterion: the loop must end. Keep the agreed clauses and let the participants close.
    for (const c of v.clauses) if (bothOk.has(c.id)) c.status = "agreed";
    s.draft.improvable = false;
    log(s, null, `round limit (${MAX_ROUNDS}) reached; please choose how to close`);
    return store.save(s);
  }
  const feedback = { A: s.draft.feedback.A, B: s.draft.feedback.B };
  const input = { title: s.title, names: names(s), problemStatement: s.map.problemStatement, version: v, feedback };
  runJob(s, "revise", () => llm.reviseDraft(input), (cur, out) => {
    pushVersion(cur, out, current(cur), bothOk);
  });
  return s;
}

export function checkBatna(s, who) {
  assertState(s, "SINGLE_TEXT_REVISION");
  const key = `batna_${who}`;
  assertNoJob(s, key);
  const me = s.participants[who];
  const input = { title: s.title, name: me.name, own: me.statements, version: current(s) };
  runJob(s, key, () => llm.batnaCheck(input), (cur, out) => {
    cur.participants[who].batnaCheck = { ...out, version: current(cur).n };
  });
  return s;
}

// ---------- Pause, outcomes, deletion ----------

export function pause(s, who, reason) {
  assertActive(s);
  s.paused = { by: who, at: now(), reason: (reason || "").slice(0, 500) };
  log(s, who, "paused the process");
  return store.save(s);
}

export function resume(s, who) {
  if (!s.paused) fail("Not paused.");
  s.paused = null;
  log(s, who, "resumed the process");
  return store.save(s);
}

// No agreement can be declared unilaterally at any time (each side may always walk away).
// Partial agreement and clarified disagreement are joint statements and need the other side's consent.
export function proposeOutcome(s, who, { type, note }) {
  if (TERMINAL.includes(s.state)) fail("This process has ended.");
  if (type === "NO_AGREEMENT") return finish(s, "NO_AGREEMENT", who, note);
  assertActive(s);
  if (!["PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT"].includes(type)) fail("Invalid outcome.", 400);
  if (type === "PARTIAL_AGREEMENT" && !(s.draft && current(s).clauses.some((c) => c.status === "agreed"))) {
    fail("A partial agreement needs at least one clause both have agreed to.", 400);
  }
  if (type === "CLARIFIED_DISAGREEMENT" && !s.map) fail("Clarified disagreement requires a shared problem map first.", 400);
  s.outcome = { proposal: { type, by: who, at: now(), note: (note || "").slice(0, 2000) } };
  log(s, who, `proposed to close as ${type}`);
  return store.save(s);
}

export function respondOutcome(s, who, { accept }) {
  const prop = s.outcome?.proposal;
  if (!prop) fail("No pending proposal.");
  if (prop.by === who) {
    s.outcome.proposal = null;
    log(s, who, "withdrew their closing proposal");
    return store.save(s);
  }
  if (!accept) {
    s.outcome.proposal = null;
    log(s, who, `declined to close as ${prop.type}`);
    return store.save(s);
  }
  return finish(s, prop.type, who, prop.note);
}

function finish(s, type, who, note) {
  s.state = type;
  s.paused = null;
  s.outcome = { ...(s.outcome || {}), proposal: null, final: { type, at: now(), by: who, note: note || "" } };
  log(s, who, `closed the process: ${type}`);
  return store.save(s);
}

// ---------- View (privacy filter) ----------

export function view(s, who) {
  const me = s.participants[who];
  const them = s.participants[other(who)];
  const statementText = new Map(
    ["A", "B"].flatMap((p) => (s.participants[p]?.statements || []).map((st) => [st.id, st])),
  );
  const jobs = Object.fromEntries(
    Object.entries(s.jobs).filter(([k]) => !/_(A|B)$/.test(k) || k.endsWith(`_${who}`)).map(([k, v]) => [k.replace(/_(A|B)$/, ""), v]),
  );
  return {
    id: s.id,
    version: s.version,
    title: s.title,
    state: s.state,
    paused: s.paused,
    you: who,
    joinCode: who === "A" ? s.joinCode : null,
    names: { A: s.participants.A.name, B: s.participants.B?.name || null },
    me: {
      name: me.name,
      intake: me.intake,
      sharing: me.sharing,
      intakeStatus: me.intakeStatus,
      statements: me.statements,
      clarifyingQuestions: me.clarifyingQuestions,
      safety: me.safety,
      batnaCheck: me.batnaCheck,
    },
    // Only progress of the other participant, never their intake or statements.
    them: them ? { name: them.name, intakeStatus: them.intakeStatus } : null,
    map: s.map && {
      problemStatement: s.map.problemStatement,
      done: s.map.done,
      items: s.map.items.map((i) => ({
        id: i.id,
        area: i.area,
        text: i.text,
        origin: i.origin,
        revisionOf: i.revisionOf || null,
        superseded: isSuperseded(s, i),
        status: itemStatus(i),
        yourVote: i.votes[who],
        // The other side's vote becomes visible once you have voted yourself, to avoid anchoring.
        theirVote: i.votes[who] ? i.votes[other(who)] : i.votes[other(who)] ? { vote: "hidden" } : null,
        // Provenance: your own statements in full; the other side's only when shared verbatim.
        basis: i.refs.map((r) => {
          const st = statementText.get(r);
          if (!st) return null;
          if (r[0] === who || st.sharing === "verbatim") return { id: r, text: st.text, category: st.category };
          return { id: r, text: null, category: st.category };
        }).filter(Boolean),
      })),
    },
    options: s.options,
    draft: s.draft && {
      versions: s.draft.versions,
      improvable: s.draft.improvable,
      yourFeedback: s.draft.feedback[who],
      theyResponded: !!s.draft.feedback[other(who)],
      rounds: s.draft.versions.length,
      maxRounds: MAX_ROUNDS,
    },
    outcome: s.outcome,
    jobs,
    log: s.log.slice(-50),
  };
}
