import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as flow from "./flow.js";
import * as notify from "./notify.js";
import { MOCK } from "./llm.js";

const app = express();
app.use(express.json({ limit: "200kb" }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(path.join(root, "public")));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    if (!(err instanceof flow.HttpError)) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Internal error" });
  }
};
const text = (v, max, label) => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new flow.HttpError(400, `${label} is required.`);
  return t.slice(0, max);
};

app.get("/api/config", (req, res) => res.json({ mock: MOCK }));

app.post(
  "/api/sessions",
  wrap((req) => {
    if (!req.body.consent) throw new flow.HttpError(400, "Please accept the ground rules.");
    const name = text(req.body.name, 60, "Name");
    const s =
      req.body.mode === "quick"
        ? flow.createSession({ mode: "quick", name, question: text(req.body.question, 2000, "The issue"), deadline: req.body.deadline })
        : flow.createSession({ title: text(req.body.title, 200, "Topic"), name });
    return { id: s.id, token: s.participants.A.token };
  }),
);

app.post(
  "/api/join",
  wrap((req) => {
    if (!req.body.consent) throw new flow.HttpError(400, "Please accept the ground rules.");
    const code = text(req.body.code, 20, "Code").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return flow.join(code, text(req.body.name, 60, "Name"));
  }),
);

// Every per-session route authenticates by the participant's secret token.
const routes = {
  "GET /": (s, who) => s,
  "DELETE /": (s) => (store.remove(s.id), notify.forget(s.id), null),
  "PUT /intake": (s, who, b) => flow.saveIntake(s, who, b),
  "POST /intake/submit": (s, who) => flow.submitIntake(s, who),
  "POST /intake/reopen": (s, who) => flow.reopenIntake(s, who),
  "PUT /statements": (s, who, b) => flow.saveStatements(s, who, b.statements),
  "POST /statements/confirm": (s, who) => flow.confirmStatements(s, who),
  "POST /map/generate": (s, who) => flow.generateMap(s, who),
  "POST /map/vote": (s, who, b) => flow.voteMap(s, who, b),
  "POST /map/add": (s, who, b) => flow.addMapItem(s, who, b),
  "POST /map/done": (s, who) => flow.finishMapReview(s, who),
  "POST /options/generate": (s, who) => flow.generateOptions(s, who),
  "POST /options/react": (s, who, b) => flow.reactOption(s, who, b),
  "POST /draft/start": (s, who, b) => flow.startDraft(s, who, b),
  "POST /draft/feedback": (s, who, b) => flow.submitFeedback(s, who, b),
  "POST /draft/batna": (s, who) => flow.checkBatna(s, who),
  "POST /pause": (s, who, b) => flow.pause(s, who, b.reason),
  "POST /resume": (s, who) => flow.resume(s, who),
  "POST /outcome/propose": (s, who, b) => flow.proposeOutcome(s, who, b),
  "POST /outcome/respond": (s, who, b) => flow.respondOutcome(s, who, b),
  "PUT /notify": (s, who, b) => flow.setNotify(s, who, b),
  // Quick mode
  "POST /quick/frame": (s, who, b) => flow.proposeFraming(s, who, b),
  "POST /quick/frame/accept": (s, who) => flow.acceptFraming(s, who),
  "PUT /quick/intake": (s, who, b) => flow.saveQuickIntake(s, who, b),
  "POST /quick/start": (s, who) => flow.startInterview(s, who),
  "POST /quick/answer": (s, who, b) => flow.answerQuick(s, who, b),
  "POST /quick/ready": (s, who) => flow.confirmBrief(s, who),
  "POST /quick/options": (s, who) => flow.generateQuickOptions(s, who),
  "POST /quick/mark": (s, who, b) => flow.markQuick(s, who, b),
  "POST /quick/confirm": (s, who, b) => flow.confirmQuick(s, who, b),
};

for (const [key, handler] of Object.entries(routes)) {
  const [method, sub] = key.split(" ");
  app[method.toLowerCase()](
    `/api/s/:id${sub === "/" ? "" : sub}`,
    wrap((req) => {
      const { s, who } = flow.auth(req.params.id, req.get("x-token"));
      const result = handler(s, who, req.body || {});
      return result ? flow.view(store.get(s.id), who) : { deleted: true };
    }),
  );
}

store.sweepExpired();
setInterval(store.sweepExpired, 3600_000).unref();

const port = Number(process.env.PORT || 3000);
export const server = app.listen(port, () => {
  console.log(`Act running on http://localhost:${server.address().port}${MOCK ? "  (LLM_MOCK=1: canned AI output)" : ""}`);
  if (!MOCK && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. AI steps will fail unless an `ant auth login` profile is available. Use `npm run mock` to try the flow without AI.");
  }
});
