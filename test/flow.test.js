// End-to-end API test with canned AI output (LLM_MOCK=1). Run: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLM_MOCK = "1";
process.env.PORT = "0";
process.env.MAX_ROUNDS = "3";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "act-test-"));
const { server } = await import("../src/server.js");
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const base = `http://localhost:${server.address().port}`;
after(() => server.close());

async function call(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
async function ok(method, url, body, token) {
  const r = await call(method, url, body, token);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function waitFor(id, token, pred) {
  for (let i = 0; i < 100; i++) {
    const v = await ok("GET", `/api/s/${id}`, null, token);
    const err = Object.values(v.jobs).find((j) => j.status === "error");
    if (err) throw new Error(err.error);
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

const secretOf = (who) => `my secret fallback plan is to move out (${who})`;
const intake = (who) => ({
  object: `Holiday plans (${who}).`,
  observations: `${who} says last year was stressful.`,
  position: `${who} wants to decide the destination.`,
  interests: `${who} needs rest.`,
  concerns: "",
  constraints: "Budget is fixed.",
  evidence: "",
  alternatives: secretOf(who),
});

async function setup() {
  const a = await ok("POST", "/api/sessions", { title: "Holidays", name: "Alex", consent: true });
  const code = (await ok("GET", `/api/s/${a.id}`, null, a.token)).joinCode;
  const b = await ok("POST", "/api/join", { code, name: "Blake", consent: true });
  assert.equal(b.id, a.id);
  // The join code is single-use.
  assert.equal((await call("POST", "/api/join", { code, name: "Eve", consent: true })).status, 404);
  const id = a.id;
  for (const [who, t] of [["Alex", a.token], ["Blake", b.token]]) {
    await ok("PUT", `/api/s/${id}/intake`, { intake: intake(who) }, t);
    await ok("POST", `/api/s/${id}/intake/submit`, null, t);
    await waitFor(id, t, (v) => v.me.intakeStatus === "extracted");
  }
  return { id, A: a.token, B: b.token };
}

test("full flow to FULL_AGREEMENT with privacy preserved", async () => {
  const { id, A, B } = await setup();
  const va = await ok("GET", `/api/s/${id}`, null, A);
  // "alternatives" defaults to private.
  assert.ok(va.me.statements.some((s) => s.text === secretOf("Alex") && s.sharing === "private"));
  await ok("POST", `/api/s/${id}/statements/confirm`, null, A);
  await ok("POST", `/api/s/${id}/statements/confirm`, null, B);
  let v = await waitFor(id, A, (x) => x.state === "SHARED_MAP_PROPOSED");

  // Private text never reaches the other side's view.
  const vb = await ok("GET", `/api/s/${id}`, null, B);
  assert.ok(!JSON.stringify(vb).includes(secretOf("Alex")), "private text leaked");
  // Provenance hides the other side's paraphrase-only statements.
  for (const item of vb.map.items) for (const b of item.basis) if (b.id.startsWith("A")) assert.equal(b.text, null);

  // The other side's vote stays hidden until you vote.
  const item = v.map.items[0];
  await ok("POST", `/api/s/${id}/map/vote`, { itemId: item.id, vote: "accept" }, B);
  v = await ok("GET", `/api/s/${id}`, null, A);
  assert.equal(v.map.items[0].theirVote.vote, "hidden");

  // A revision creates a new candidate the other side must answer.
  await ok("POST", `/api/s/${id}/map/vote`, { itemId: item.id, vote: "accept_with_revision", revision: "We both want a restful holiday." }, A);
  v = await ok("GET", `/api/s/${id}`, null, B);
  const rev = v.map.items.find((i) => i.revisionOf === item.id);
  assert.equal(rev.status, "pending");
  assert.equal((await call("POST", `/api/s/${id}/map/done`, null, B)).status, 400);
  for (const i of v.map.items) await ok("POST", `/api/s/${id}/map/vote`, { itemId: i.id, vote: "accept" }, B);
  v = await ok("GET", `/api/s/${id}`, null, A);
  assert.equal(v.map.items.find((i) => i.id === rev.id).status, "confirmed");
  assert.ok(v.map.items.find((i) => i.id === item.id).superseded);
  for (const i of v.map.items.filter((i) => !i.yourVote && !i.superseded)) await ok("POST", `/api/s/${id}/map/vote`, { itemId: i.id, vote: "uncertain" }, A);
  await ok("POST", `/api/s/${id}/map/done`, null, A);
  await ok("POST", `/api/s/${id}/map/done`, null, B);
  v = await waitFor(id, A, (x) => x.state === "OPTIONS_GENERATED");

  await ok("POST", `/api/s/${id}/options/react`, { optionId: v.options.items[0].id, reaction: "promising" }, B);
  await ok("POST", `/api/s/${id}/draft/start`, { optionIds: [v.options.items[0].id] }, A);
  v = await waitFor(id, A, (x) => x.state === "SINGLE_TEXT_REVISION");
  const [c1, c2] = v.draft.versions[0].clauses;

  // Round 1: A wants c1 changed, B accepts everything.
  await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: { [c1.id]: { verdict: "change", text: "Try it for 2 weeks." }, [c2.id]: { verdict: "ok" } } }, A);
  const fbView = await ok("GET", `/api/s/${id}`, null, B);
  assert.ok(!JSON.stringify(fbView).includes("Try it for 2 weeks"), "A's draft feedback visible to B");
  await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: { [c1.id]: { verdict: "ok" }, [c2.id]: { verdict: "ok" } } }, B);
  v = await waitFor(id, A, (x) => x.draft.versions.length === 2);
  const v1 = v.draft.versions[1];
  assert.equal(v1.clauses.find((c) => c.id === c1.id).text, "Try it for 2 weeks.");
  assert.equal(v1.clauses.find((c) => c.id === c1.id).status, "open");
  assert.equal(v1.clauses.find((c) => c.id === c2.id).status, "agreed");

  // The alternative (BATNA) check is private to whoever asked for it.
  await ok("POST", `/api/s/${id}/draft/batna`, null, B);
  await waitFor(id, B, (x) => x.me.batnaCheck);
  assert.equal((await ok("GET", `/api/s/${id}`, null, A)).me.batnaCheck, null);

  // Round 2: both accept every clause -> full agreement.
  const all = Object.fromEntries(v1.clauses.map((c) => [c.id, { verdict: "ok" }]));
  await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: all }, A);
  v = await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: all }, B);
  assert.equal(v.state, "FULL_AGREEMENT");
  assert.equal((await call("POST", `/api/s/${id}/pause`, {}, A)).status, 409);
});

test("bracketed conflict, round limit, partial agreement needs consent", async () => {
  const { id, A, B } = await setup();
  await ok("POST", `/api/s/${id}/statements/confirm`, null, A);
  await ok("POST", `/api/s/${id}/statements/confirm`, null, B);
  let v = await waitFor(id, A, (x) => x.state === "SHARED_MAP_PROPOSED");
  for (const t of [A, B]) {
    for (const i of v.map.items) await ok("POST", `/api/s/${id}/map/vote`, { itemId: i.id, vote: "accept" }, t);
    await ok("POST", `/api/s/${id}/map/done`, null, t);
  }
  v = await waitFor(id, A, (x) => x.state === "OPTIONS_GENERATED");
  await ok("POST", `/api/s/${id}/draft/start`, { optionIds: v.options.items.map((o) => o.id) }, B);
  v = await waitFor(id, A, (x) => x.state === "SINGLE_TEXT_REVISION");

  // A paused session rejects changes until resumed.
  await ok("POST", `/api/s/${id}/pause`, { reason: "need a break" }, A);
  assert.equal((await call("POST", `/api/s/${id}/draft/batna`, null, B)).status, 409);
  await ok("POST", `/api/s/${id}/resume`, null, B);

  // Partial agreement is impossible before any clause is agreed.
  assert.equal((await call("POST", `/api/s/${id}/outcome/propose`, { type: "PARTIAL_AGREEMENT" }, A)).status, 400);

  while (v.draft.versions.length < 3) {
    const cl = v.draft.versions.at(-1).clauses;
    const fb = (who) => Object.fromEntries(cl.map((c, i) => [c.id, i === 0 ? { verdict: "change", text: `${who} version` } : { verdict: "ok" }]));
    await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: fb("A") }, A);
    await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: fb("B") }, B);
    const n = v.draft.versions.length;
    v = await waitFor(id, A, (x) => x.draft.versions.length > n);
  }
  const last = v.draft.versions.at(-1);
  assert.equal(last.clauses[0].status, "bracketed");
  assert.ok(last.clauses.slice(1).every((c) => c.status === "agreed"));

  // Round limit (MAX_ROUNDS=3): more feedback does not trigger another revision.
  const fb = Object.fromEntries(last.clauses.map((c, i) => [c.id, i === 0 ? { verdict: "change", text: "x" } : { verdict: "ok" }]));
  await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: fb }, A);
  v = await ok("POST", `/api/s/${id}/draft/feedback`, { clauses: fb }, B);
  assert.equal(v.draft.versions.length, 3);
  assert.equal(v.draft.improvable, false);

  // The proposer cannot confirm their own proposal; responding withdraws it.
  await ok("POST", `/api/s/${id}/outcome/propose`, { type: "PARTIAL_AGREEMENT", note: "good enough" }, A);
  v = await ok("POST", `/api/s/${id}/outcome/respond`, { accept: true }, A);
  assert.equal(v.outcome.proposal, null);
  await ok("POST", `/api/s/${id}/outcome/propose`, { type: "PARTIAL_AGREEMENT" }, A);
  v = await ok("POST", `/api/s/${id}/outcome/respond`, { accept: true }, B);
  assert.equal(v.state, "PARTIAL_AGREEMENT");
});

test("no agreement is unilateral; deletion; auth", async () => {
  const { id, A, B } = await setup();
  assert.equal((await call("GET", `/api/s/${id}`, null, "wrong")).status, 403);
  const v = await ok("POST", `/api/s/${id}/outcome/propose`, { type: "NO_AGREEMENT" }, B);
  assert.equal(v.state, "NO_AGREEMENT");
  await ok("DELETE", `/api/s/${id}`, null, A);
  assert.equal((await call("GET", `/api/s/${id}`, null, B)).status, 404);
});

test("quick mode: framing, private interview, sealed choices, gap round, agreement", async () => {
  const a = await ok("POST", "/api/sessions", { mode: "quick", question: "Who picks up the kids on Friday", name: "Alex", consent: true });
  let v = await waitFor(a.id, a.token, (x) => x.quick.framing);
  assert.equal(v.state, "QUICK_FRAMING");
  assert.equal(v.quick.framing.text, "Who picks up the kids on Friday?");
  const b = await ok("POST", "/api/join", { code: v.joinCode, name: "Blake", consent: true });
  const { id } = a;
  const [A, B] = [a.token, b.token];
  // The other side sees only the neutralised question, never the raw wording.
  assert.equal((await ok("GET", `/api/s/${id}`, null, B)).me.quick.frameRaw, null);
  assert.equal((await ok("GET", `/api/s/${id}`, null, B)).yourTurn, true);
  v = await ok("POST", `/api/s/${id}/quick/frame/accept`, null, B);
  assert.equal(v.state, "QUICK_INTERVIEW");

  const secret = "If this fails I will call my lawyer";
  await ok("PUT", `/api/s/${id}/quick/intake`, { intake: { need: "Be at work until 5.", proposal: "Blake picks up.", limits: "Not before 6.", fallback: secret } }, A);
  await ok("PUT", `/api/s/${id}/quick/intake`, { intake: { need: "Gym at 4.", proposal: "Alex picks up.", limits: "", fallback: "" } }, B);
  for (const t of [A, B]) {
    await ok("POST", `/api/s/${id}/quick/start`, null, t);
    // Claude asks a follow-up question first (mock: one question).
    v = await waitFor(id, t, (x) => x.me.quick.questions.length);
    assert.equal(v.yourTurn, true);
    await ok("POST", `/api/s/${id}/quick/answer`, { answer: "5:30 works." }, t);
    v = await waitFor(id, t, (x) => x.me.quick.status === "review");
    assert.ok(!JSON.stringify(v.me.quick.brief).includes("lawyer"), "fallback leaked into brief");
  }
  assert.ok(!JSON.stringify(await ok("GET", `/api/s/${id}`, null, B)).includes(secret), "A's private text visible to B");
  await ok("POST", `/api/s/${id}/quick/ready`, null, A);
  await ok("POST", `/api/s/${id}/quick/ready`, null, B);
  v = await waitFor(id, A, (x) => x.state === "QUICK_OPTIONS");
  const [o1, o2, o3] = v.quick.options.items.map((i) => i.id);

  // Round 1: no overlap -> sealed marks stay hidden, then a gap interview starts for both.
  await ok("POST", `/api/s/${id}/quick/mark`, { marks: { [o1]: "prefer", [o2]: "no", [o3]: "no" } }, A);
  v = await ok("GET", `/api/s/${id}`, null, B);
  assert.equal(v.quick.options.theyMarked, true);
  assert.equal(v.quick.options.theirMarks, null);
  v = await ok("POST", `/api/s/${id}/quick/mark`, { marks: { [o1]: "no", [o2]: "prefer", [o3]: "no" } }, B);
  v = await waitFor(id, A, (x) => x.state === "QUICK_INTERVIEW" && x.me.quick.questions.length);
  assert.equal(v.me.quick.phase, 1);
  for (const t of [A, B]) {
    await ok("POST", `/api/s/${id}/quick/answer`, { answer: "6pm could work." }, t);
    await waitFor(id, t, (x) => x.me.quick.status === "review");
    await ok("POST", `/api/s/${id}/quick/ready`, null, t);
  }
  v = await waitFor(id, A, (x) => x.state === "QUICK_OPTIONS" && x.quick.round === 2);

  // Round 2: both accept the middle option -> confirm -> full agreement.
  const ids = v.quick.options.items.map((i) => i.id);
  await ok("POST", `/api/s/${id}/quick/mark`, { marks: { [ids[0]]: "ok", [ids[1]]: "no", [ids[2]]: "prefer" } }, A);
  v = await ok("POST", `/api/s/${id}/quick/mark`, { marks: { [ids[0]]: "no", [ids[1]]: "ok", [ids[2]]: "ok" } }, B);
  assert.equal(v.state, "QUICK_CONFIRM");
  assert.equal(v.quick.confirm.optionId, ids[2]);
  assert.equal(v.quick.options.theirMarks[ids[2]], "prefer");
  await ok("POST", `/api/s/${id}/quick/confirm`, { accept: true }, A);
  v = await ok("POST", `/api/s/${id}/quick/confirm`, { accept: true }, B);
  assert.equal(v.state, "FULL_AGREEMENT");
  assert.equal(v.quick.agreement.id, ids[2]);
});

test("quick mode: round limit, then clarified disagreement by consent", async () => {
  const a = await ok("POST", "/api/sessions", { mode: "quick", question: "Who keeps the car this weekend?", name: "Alex", consent: true });
  let v = await waitFor(a.id, a.token, (x) => x.quick.framing);
  const b = await ok("POST", "/api/join", { code: v.joinCode, name: "Blake", consent: true });
  const { id } = a;
  // B rewords the question; A must accept the new wording.
  await ok("POST", `/api/s/${id}/quick/frame`, { question: "How is the car shared this weekend" }, b.token);
  v = await waitFor(id, a.token, (x) => x.quick.framing.by === "B");
  assert.equal(v.quick.framing.acceptedBy.A, false);
  await ok("POST", `/api/s/${id}/quick/frame/accept`, null, a.token);
  for (const t of [a.token, b.token]) {
    await ok("PUT", `/api/s/${id}/quick/intake`, { intake: { need: "x", proposal: "y" } }, t);
    await ok("POST", `/api/s/${id}/quick/start`, null, t);
    await waitFor(id, t, (x) => x.me.quick.questions.length);
    await ok("POST", `/api/s/${id}/quick/ready`, null, t); // skip the questions
  }
  for (let round = 1; round <= 3; round++) {
    v = await waitFor(id, a.token, (x) => x.state === "QUICK_OPTIONS" && x.quick.round === round);
    const [x, y] = v.quick.options.items.map((i) => i.id);
    const others = Object.fromEntries(v.quick.options.items.slice(2).map((i) => [i.id, "no"]));
    await ok("POST", `/api/s/${id}/quick/mark`, { marks: { ...others, [x]: "prefer", [y]: "no" } }, a.token);
    await ok("POST", `/api/s/${id}/quick/mark`, { marks: { ...others, [x]: "no", [y]: "prefer" } }, b.token);
    if (round < 3) {
      for (const t of [a.token, b.token]) {
        await waitFor(id, t, (z) => z.me.quick.status === "interviewing" && z.me.quick.questions.length);
        await ok("POST", `/api/s/${id}/quick/ready`, null, t);
      }
    }
  }
  v = await ok("GET", `/api/s/${id}`, null, a.token);
  assert.equal(v.state, "QUICK_OPTIONS");
  assert.equal(v.quick.options.exhausted, true);
  await ok("POST", `/api/s/${id}/outcome/propose`, { type: "CLARIFIED_DISAGREEMENT" }, a.token);
  v = await ok("POST", `/api/s/${id}/outcome/respond`, { accept: true }, b.token);
  assert.equal(v.state, "CLARIFIED_DISAGREEMENT");
});

test("config exposes quick-only flag, operator and retention for the ground rules", async () => {
  const c = await ok("GET", "/api/config");
  assert.equal(c.mock, true);
  assert.equal(c.quickOnly, false);
  assert.equal(c.operator, null);
  assert.equal(typeof c.retentionDays, "number");
});
