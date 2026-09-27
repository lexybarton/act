// Session model, state machine, background jobs and the per-participant (privacy-filtered) view.
import * as store from "./store.js";
import * as llm from "./llm.js";
import * as notify from "./notify.js";

// Every write goes through here so that "your turn" pings fire on any state change.
function save(s) {
  store.save(s);
  notify.update(s, yourTurn);
  return s;
}

export const QUICK_STATES = ["QUICK_FRAMING", "QUICK_INTERVIEW", "QUICK_OPTIONS", "QUICK_CONFIRM"];
export const STATES = [
  ...QUICK_STATES,
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
    notify: null, // ntfy topic for "your turn" pings
    quick: null,
  };
}

export function createSession({ title, name, mode, question, deadline }) {
  const quick = mode === "quick";
  const s = {
    id: store.newId(),
    joinCode: store.newJoinCode(),
    mode: quick ? "quick" : "full",
    title: quick ? "Quick resolution" : title,
    createdAt: now(),
    state: quick ? "QUICK_FRAMING" : "CREATED",
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
  if (!quick) return save(s);
  s.quick = { framing: null, round: 0, options: null, history: [], confirm: null, agreement: null };
  s.participants.A.quick = newQuickParticipant();
  save(s);
  return proposeFraming(s, "A", { question, deadline });
}

export function join(code, name) {
  const s = store.findByJoinCode(code);
  if (!s) fail("Unknown or already used code.", 404);
  s.participants.B = newParticipant(name);
  s.joinCode = null; // one-time
  if (s.mode === "quick") s.participants.B.quick = newQuickParticipant();
  else s.state = "PRIVATE_INTAKE";
  log(s, "B", "joined");
  save(s);
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
  save(s);
  work()
    .then((result) => {
      const cur = store.get(s.id);
      if (!cur) return; // deleted meanwhile
      apply(cur, result);
      cur.jobs[key] = { status: "done", at: now() };
      save(cur);
    })
    .catch((err) => {
      console.error(`[job ${key}]`, err);
      const cur = store.get(s.id);
      if (!cur) return;
      cur.jobs[key] = { status: "error", error: err.message || String(err), at: now() };
      save(cur);
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
  return save(s);
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
  return save(s);
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
  return save(s);
}

export function reopenIntake(s, who) {
  assertState(s, "CREATED", "PRIVATE_INTAKE");
  const me = s.participants[who];
  me.intakeStatus = "draft";
  log(s, who, "reopened their intake");
  return save(s);
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
  return save(s);
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
  return save(s);
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
  return save(s);
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
  return save(s);
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
  if (!fo) return save(s);

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
    return save(s);
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

// ---------- Quick mode ----------
// One agreed question. Claude interviews each side privately, asking for whatever it still needs,
// then proposes concrete options that both mark privately (prefer / ok / no). If no option works for
// both, Claude goes back to each side with gap-focused questions and tries again, up to QUICK_MAX_ROUNDS.

export const QUICK_MAX_ROUNDS = Number(process.env.QUICK_MAX_ROUNDS || 3);
const QUICK_MAX_TURNS = 3; // AI question turns per interview phase before it must produce options
const QUICK_FIELDS = ["need", "proposal", "limits", "fallback"];
const MARKS = ["prefer", "ok", "no"];

function newQuickParticipant() {
  return {
    intake: Object.fromEntries(QUICK_FIELDS.map((f) => [f, ""])),
    status: "draft", // draft -> interviewing -> review -> ready
    phase: 0, // 0 = first interview, n = gap interview after round n
    transcript: [], // { phase, role: "ai", questions } | { phase, role: "me", text }
    questions: [],
    brief: null,
    note: "",
    safety: null,
    frameRaw: null, // own un-neutralised wording of the question; never shown to the other side
  };
}

function assertQuick(s, ...states) {
  if (s.mode !== "quick") fail("Only available in quick mode.");
  assertState(s, ...states);
}

function parseDeadline(v) {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail("Invalid deadline.", 400);
  return new Date(t).toISOString();
}

export function proposeFraming(s, who, { question, deadline }) {
  assertQuick(s, "QUICK_FRAMING");
  const text = (question || "").trim().slice(0, 2000);
  if (!text) fail("Describe the one issue to settle.", 400);
  const dl = parseDeadline(deadline);
  assertNoJob(s, "frame");
  const me = s.participants[who];
  me.quick.frameRaw = text;
  runJob(s, "frame", () => llm.quickFrame({ question: text, name: me.name }), (cur, out) => {
    cur.quick.framing = {
      text: out.question.trim().slice(0, 500),
      note: out.note,
      deadline: dl,
      by: who,
      acceptedBy: { A: who === "A", B: who === "B" },
    };
    cur.title = cur.quick.framing.text.slice(0, 200);
    log(cur, who, "proposed the question to settle");
  });
  return s;
}

export function acceptFraming(s, who) {
  assertQuick(s, "QUICK_FRAMING");
  const f = s.quick.framing;
  if (!f) fail("No question proposed yet.");
  if (!s.participants.B) fail("Wait until the other participant has joined.");
  f.acceptedBy[who] = true;
  log(s, who, "accepted the question");
  if (f.acceptedBy.A && f.acceptedBy.B) {
    s.state = "QUICK_INTERVIEW";
    log(s, null, "question agreed");
  }
  return save(s);
}

export function saveQuickIntake(s, who, { intake }) {
  assertQuick(s, "QUICK_FRAMING", "QUICK_INTERVIEW");
  const me = s.participants[who].quick;
  if (me.status !== "draft") fail("Your answers are already with Claude.");
  for (const f of QUICK_FIELDS) if (typeof intake?.[f] === "string") me.intake[f] = intake[f].slice(0, 4000);
  return save(s);
}

export function startInterview(s, who) {
  assertQuick(s, "QUICK_INTERVIEW");
  const me = s.participants[who].quick;
  if (me.status !== "draft") fail("Already started.");
  for (const f of ["need", "proposal"]) if (!me.intake[f].trim()) fail("Please say what you need and what you propose.", 400);
  me.status = "interviewing";
  log(s, who, "started their private interview");
  return runInterview(s, who);
}

function runInterview(s, who) {
  const key = `interview_${who}`;
  assertNoJob(s, key);
  const me = s.participants[who];
  const them = s.participants[other(who)];
  const q = me.quick;
  const transcript = q.transcript.filter((t) => t.phase === q.phase);
  const last = s.quick.history.at(-1);
  const input = {
    question: s.quick.framing.text,
    deadline: s.quick.framing.deadline,
    name: me.name,
    otherName: them.name,
    intake: { ...q.intake },
    transcript,
    gap: q.phase && last
      ? { options: last.options, ownMarks: last.marks[who], declined: !!last.declinedBy, declinedByMe: last.declinedBy === who }
      : null,
    // In gap rounds the other side's brief (paraphrase-level) is used only to test bridging arrangements.
    otherBrief: q.phase && them.quick.brief ? them.quick.brief : null,
    forceReady: transcript.filter((t) => t.role === "ai").length >= QUICK_MAX_TURNS,
  };
  runJob(s, key, () => llm.quickInterview(input), (cur, out) => {
    const p = cur.participants[who].quick;
    p.brief = out.brief;
    p.note = out.note;
    p.safety = out.safety.concern ? out.safety.note : null;
    const questions = out.questions.map((x) => x.trim()).filter(Boolean).slice(0, 3);
    if (out.ready || input.forceReady || !questions.length) {
      p.status = "review";
      p.questions = [];
    } else {
      p.questions = questions;
      p.transcript.push({ phase: p.phase, role: "ai", questions, at: now() });
    }
  });
  return s;
}

export function answerQuick(s, who, { answer }) {
  assertQuick(s, "QUICK_INTERVIEW");
  const q = s.participants[who].quick;
  if (!["interviewing", "review"].includes(q.status)) fail("Nothing to answer right now.");
  const text = (answer || "").trim().slice(0, 4000);
  if (!text) fail("Please write an answer.", 400);
  // In review, an answer is a correction of the brief.
  q.transcript.push({ phase: q.phase, role: "me", text: q.status === "review" ? `Correction to your summary: ${text}` : text, at: now() });
  q.status = "interviewing";
  q.questions = [];
  return runInterview(s, who);
}

export function confirmBrief(s, who) {
  assertQuick(s, "QUICK_INTERVIEW");
  const q = s.participants[who].quick;
  assertNoJob(s, `interview_${who}`);
  // "Skip the questions" is allowed once Claude has a brief to work from.
  if (!(q.status === "review" || (q.status === "interviewing" && q.brief))) fail("Nothing to confirm yet.");
  q.status = "ready";
  q.questions = [];
  log(s, who, "is ready for options");
  if (s.participants[other(who)].quick.status === "ready") return generateQuickOptions(s, who);
  return save(s);
}

export function generateQuickOptions(s, who) {
  assertQuick(s, "QUICK_INTERVIEW");
  if (!["A", "B"].every((p) => s.participants[p].quick.status === "ready")) fail("Both sides must be ready first.");
  if (s.quick.round >= QUICK_MAX_ROUNDS) fail("The round limit is reached.");
  assertNoJob(s, "qoptions");
  const input = {
    question: s.quick.framing.text,
    deadline: s.quick.framing.deadline,
    names: names(s),
    briefA: s.participants.A.quick.brief,
    briefB: s.participants.B.quick.brief,
    history: s.quick.history,
  };
  runJob(s, "qoptions", () => llm.quickOptions(input), (cur, out) => {
    const round = cur.quick.round + 1;
    cur.quick.round = round;
    cur.quick.options = {
      round,
      items: out.options.slice(0, 4).map((o, i) => ({ id: `R${round}.${i + 1}`, ...o })),
      marks: { A: null, B: null },
      exhausted: false,
    };
    cur.state = "QUICK_OPTIONS";
    log(cur, null, `options round ${round} ready`);
  });
  return s;
}

export function markQuick(s, who, { marks }) {
  assertQuick(s, "QUICK_OPTIONS");
  const o = s.quick.options;
  if (o.exhausted) fail("The round limit is reached. Please choose how to close.");
  if (o.marks[who]) fail("You already sent your choices for this round.");
  const clean = {};
  for (const item of o.items) {
    if (!MARKS.includes(marks?.[item.id])) fail("Please mark every option.", 400);
    clean[item.id] = marks[item.id];
  }
  o.marks[who] = clean;
  log(s, who, `sent their sealed choices for round ${o.round}`);
  if (!o.marks[other(who)]) return save(s);

  // Both sealed choices are in: pick the option both can live with that they like most together.
  const score = { prefer: 2, ok: 1 };
  const both = o.items.filter((i) => o.marks.A[i.id] !== "no" && o.marks.B[i.id] !== "no");
  const best = both.sort((x, y) => score[o.marks.A[y.id]] + score[o.marks.B[y.id]] - score[o.marks.A[x.id]] - score[o.marks.B[x.id]])[0];
  s.quick.history.push({ round: o.round, options: o.items.map(({ id, title, terms }) => ({ id, title, terms })), marks: o.marks, match: best?.id || null, declinedBy: null });
  if (best) {
    s.state = "QUICK_CONFIRM";
    s.quick.confirm = { optionId: best.id, A: null, B: null };
    log(s, null, `both can accept "${best.title}"; waiting for final confirmation`);
    return save(s);
  }
  log(s, null, `no option in round ${o.round} works for both`);
  return nextRound(s);
}

// No match: go back to each side privately with gap-focused questions, or stop at the round limit.
function nextRound(s) {
  if (s.quick.round >= QUICK_MAX_ROUNDS) {
    s.state = "QUICK_OPTIONS";
    s.quick.options.exhausted = true;
    s.quick.confirm = null;
    log(s, null, `round limit (${QUICK_MAX_ROUNDS}) reached; please choose how to close`);
    return save(s);
  }
  s.state = "QUICK_INTERVIEW";
  s.quick.confirm = null;
  for (const p of ["A", "B"]) {
    const q = s.participants[p].quick;
    q.phase = s.quick.round;
    q.status = "interviewing";
    q.questions = [];
  }
  runInterview(s, "A");
  return runInterview(s, "B");
}

export function confirmQuick(s, who, { accept, note }) {
  assertQuick(s, "QUICK_CONFIRM");
  const c = s.quick.confirm;
  if (c[who] !== null) fail("You already answered.");
  c[who] = !!accept;
  if (!accept) {
    const q = s.participants[who].quick;
    const why = (note || "").trim().slice(0, 2000);
    // The reason is private: it only goes into the decliner's own gap interview.
    q.transcript.push({ phase: s.quick.round, role: "me", text: `I declined "${s.quick.options.items.find((i) => i.id === c.optionId).title}" at the final confirmation${why ? `: ${why}` : "."}`, at: now() });
    s.quick.history.at(-1).declinedBy = who;
    log(s, who, "declined the matched option at the final confirmation");
    return nextRound(s);
  }
  log(s, who, "confirmed the agreement");
  if (c.A && c.B) {
    s.quick.agreement = s.quick.options.items.find((i) => i.id === c.optionId);
    return finish(s, "FULL_AGREEMENT", who);
  }
  return save(s);
}

export function setNotify(s, who, { topic }) {
  const t = (topic || "").trim();
  if (t && !notify.validTopic(t)) fail("Topic: 8-64 letters, digits, - or _.", 400);
  s.participants[who].notify = t || null;
  return save(s);
}

// Whether the participant has something to do now. Drives the UI's "your turn" signal and pings.
export function yourTurn(s, who) {
  const me = s.participants[who];
  if (!me || TERMINAL.includes(s.state) || s.paused) return false;
  if (s.outcome?.proposal && s.outcome.proposal.by !== who) return true;
  if (s.mode !== "quick") return false;
  const running = (k) => s.jobs[k]?.status === "running";
  const q = me.quick;
  switch (s.state) {
    case "QUICK_FRAMING":
      return !!(s.quick.framing && !s.quick.framing.acceptedBy[who] && !running("frame"));
    case "QUICK_INTERVIEW":
      if (running(`interview_${who}`)) return false;
      return q.status === "draft" || q.status === "review" || (q.status === "interviewing" && q.questions.length > 0);
    case "QUICK_OPTIONS":
      return s.quick.options.exhausted || !s.quick.options.marks[who];
    case "QUICK_CONFIRM":
      return s.quick.confirm[who] === null;
  }
  return false;
}

// ---------- Pause, outcomes, deletion ----------

export function pause(s, who, reason) {
  assertActive(s);
  s.paused = { by: who, at: now(), reason: (reason || "").slice(0, 500) };
  log(s, who, "paused the process");
  return save(s);
}

export function resume(s, who) {
  if (!s.paused) fail("Not paused.");
  s.paused = null;
  log(s, who, "resumed the process");
  return save(s);
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
  if (type === "CLARIFIED_DISAGREEMENT" && !s.map && !(s.quick?.round > 0)) {
    fail("Clarified disagreement requires a shared problem map (or a round of options) first.", 400);
  }
  s.outcome = { proposal: { type, by: who, at: now(), note: (note || "").slice(0, 2000) } };
  log(s, who, `proposed to close as ${type}`);
  return save(s);
}

export function respondOutcome(s, who, { accept }) {
  const prop = s.outcome?.proposal;
  if (!prop) fail("No pending proposal.");
  if (prop.by === who) {
    s.outcome.proposal = null;
    log(s, who, "withdrew their closing proposal");
    return save(s);
  }
  if (!accept) {
    s.outcome.proposal = null;
    log(s, who, `declined to close as ${prop.type}`);
    return save(s);
  }
  return finish(s, prop.type, who, prop.note);
}

function finish(s, type, who, note) {
  s.state = type;
  s.paused = null;
  s.outcome = { ...(s.outcome || {}), proposal: null, final: { type, at: now(), by: who, note: note || "" } };
  log(s, who, `closed the process: ${type}`);
  return save(s);
}

// ---------- View (privacy filter) ----------

function quickView(s, who) {
  const q = s.quick;
  const o = q.options;
  const theirs = o?.marks[other(who)];
  return {
    framing: q.framing,
    round: q.round,
    maxRounds: QUICK_MAX_ROUNDS,
    // Choices are sealed: you see the other side's marks only once both have sent theirs.
    options: o && {
      round: o.round,
      items: o.items,
      exhausted: o.exhausted,
      yourMarks: o.marks[who],
      theyMarked: !!theirs,
      theirMarks: o.marks[who] && theirs ? theirs : null,
    },
    history: q.history.map(({ declinedBy, ...r }) => ({ ...r, declined: !!declinedBy })),
    // Like votes, the other side's confirmation shows only after you answered, to avoid pressure.
    confirm: q.confirm && { optionId: q.confirm.optionId, you: q.confirm[who], them: q.confirm[who] === null ? null : q.confirm[other(who)] },
    agreement: q.agreement,
  };
}

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
    mode: s.mode || "full",
    state: s.state,
    paused: s.paused,
    yourTurn: yourTurn(s, who),
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
      notify: me.notify,
      quick: me.quick,
    },
    // Only progress of the other participant, never their intake, statements, answers or brief.
    them: them ? { name: them.name, intakeStatus: them.intakeStatus, quickStatus: them.quick?.status || null } : null,
    quick: s.quick && quickView(s, who),
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
