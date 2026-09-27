// Act client: hash routing, polling, and a full re-render from the server's per-participant view.
const $app = document.getElementById("app");

const FIELDS = [
  ["object", "Object", "What decision, situation, plan, or relationship issue is being discussed?"],
  ["observations", "Observations", "What happened, or what is currently true, from your point of view?"],
  ["position", "Position", "What outcome do you currently want?"],
  ["interests", "Interests", "Why does that outcome matter to you? What needs, fears, or values sit underneath it?"],
  ["concerns", "Concerns", "What must be avoided?"],
  ["constraints", "Constraints", "What cannot realistically change?"],
  ["evidence", "Evidence", "What information supports your account?"],
  ["alternatives", "Alternatives", "What will you do if no agreement is reached? (Usually best kept private.)"],
];
const REQUIRED = ["object", "position", "interests"];
const CATEGORIES = {
  claimed_fact: "Claimed fact",
  interpretation: "Interpretation",
  feeling: "Feeling / reaction",
  interest: "Interest",
  constraint: "Constraint",
  requested_outcome: "Requested outcome",
  possible_concession: "Possible concession",
  uncertainty: "Uncertainty",
};
const SHARING = {
  verbatim: "Shareable verbatim",
  paraphrase: "Paraphrase only",
  private: "Private",
};
const AREAS = {
  common_ground: ["Common ground", "Statements you may both accept with the same meaning."],
  compatible_interests: ["Compatible interests", "Different needs that might be satisfied together."],
  contested_facts: ["Contested facts", "You disagree about what happened or what is true."],
  conflicting_preferences: ["Conflicting preferences", "Facts may be shared, but desired outcomes differ."],
};
const VOTES = {
  accept: "Accept",
  accept_with_revision: "Accept with revision",
  uncertain: "Uncertain",
  reject: "Reject",
  not_important: "Not important",
};
const ITEM_STATUS = {
  confirmed: ["Both accepted", "ok"],
  rejected: ["Rejected", "bad"],
  set_aside: ["Set aside", ""],
  pending: ["Awaiting votes", "warn"],
  not_agreed: ["Not agreed", "warn"],
};
const BASES = {
  shared_interests: "Shared interests",
  different_priorities: "Different priorities",
  objective_criteria: "Objective criteria",
  reciprocal_concessions: "Reciprocal concessions",
  conditional_arrangement: "Conditional",
  reversible_experiment: "Reversible trial",
  alternatives_comparison: "Beats alternatives",
};
const REACTIONS = { promising: "Promising", needs_work: "Needs work", unacceptable: "Unacceptable" };
const OUTCOMES = {
  FULL_AGREEMENT: ["Full agreement", "All operative terms were accepted by both."],
  PARTIAL_AGREEMENT: ["Partial agreement", "Agreed terms are recorded; unresolved matters remain explicit."],
  CLARIFIED_DISAGREEMENT: ["Clarified disagreement", "Both understand the underlying conflict but choose differently."],
  NO_AGREEMENT: ["No agreement", "At least one participant prefers their alternative to any agreement on offer."],
};
const QUICK_STEPS = [
  ["Agree the question", ["QUICK_FRAMING"]],
  ["Private interview", ["QUICK_INTERVIEW"]],
  ["Sealed choice", ["QUICK_OPTIONS", "QUICK_CONFIRM"]],
  ["Outcome", ["FULL_AGREEMENT", "PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT", "NO_AGREEMENT"]],
];
const QUICK_FIELDS = [
  ["need", "What do you need from this?", "The one or two things that matter most to you here. *"],
  ["proposal", "What do you propose?", "A concrete answer: who, what, when, where, how much. *"],
  ["limits", "What can't you accept?", "Hard limits, and briefly why."],
  ["fallback", "Your fallback (private)", "What you'll do if you can't settle it. Never shown to anyone and never used in options; it only helps Claude understand how much room you have."],
];
const MARKS = { prefer: ["Prefer", "ok"], ok: ["Could live with it", "warn"], no: ["No", "bad"] };
const STEPS = [
  ["Private intake", ["CREATED", "PRIVATE_INTAKE"]],
  ["Problem map", ["INTAKE_CONFIRMED", "SHARED_MAP_PROPOSED"]],
  ["Options", ["SHARED_MAP_CONFIRMED", "OPTIONS_GENERATED"]],
  ["Single text", ["SINGLE_TEXT_REVISION"]],
  ["Outcome", ["FULL_AGREEMENT", "PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT", "NO_AGREEMENT"]],
];

// ---------- helpers ----------

const h = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const badge = (text, kind = "") => `<span class="badge ${kind}">${h(text)}</span>`;
const spinner = (text) => `<p><span class="spinner"></span>${h(text)}</p>`;

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), isError ? 6000 : 2500);
}

const tokenKey = (id) => `act:token:${id}`;
const storage = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* private mode: link-only access */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

async function api(method, url, body, token) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---------- state ----------

let session = null; // current view from the server
let sessionId = null;
let token = null;
let pollTimer = null;
let fastTimer = null;
let busy = false;
let quickMode = true; // home page: which kind of session to create
let homeArgs = [null, ""];
// Values of inputs the user is editing, keyed by data-k, so polling re-renders never lose typing.
const vals = {};
const val = (k, fallback = "") => (k in vals ? vals[k] : fallback);
const clearVals = (prefix) => Object.keys(vals).forEach((k) => k.startsWith(prefix) && delete vals[k]);

// Server settings: quick-only mode, who runs the server, retention.
const config = await fetch("/api/config")
  .then((r) => r.json())
  .catch(() => ({}));
if (config.quickOnly) quickMode = true;

// ---------- routing ----------

window.addEventListener("hashchange", route);
route();

function route() {
  clearInterval(pollTimer);
  clearTimeout(fastTimer);
  session = null;
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "s" && parts[1]) {
    sessionId = parts[1];
    if (parts[2]) {
      // Private link from another device: store the token, then drop it from the address bar.
      storage.set(tokenKey(sessionId), parts[2]);
      history.replaceState(null, "", `#/s/${sessionId}`);
    }
    token = storage.get(tokenKey(sessionId));
    if (!token) return renderHome("You have no access to this session on this device. Use your private link or a join code.");
    $app.innerHTML = spinner("Loading…");
    refresh();
    pollTimer = setInterval(refresh, 3000);
  } else {
    sessionId = token = null;
    renderHome(null, parts[0] === "join" ? parts[1] : "");
  }
}

async function refresh() {
  if (busy) return;
  try {
    const v = await api("GET", `/api/s/${sessionId}`, null, token);
    if (!session || v.version !== session.version) {
      const wasTurn = session?.yourTurn;
      session = v;
      render();
      if (v.yourTurn && wasTurn === false) signalTurn();
    }
    pollSoonIfBusy();
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      clearInterval(pollTimer);
      storage.del(tokenKey(sessionId));
      renderHome(e.status === 404 ? "This session no longer exists." : "Your access to this session is not valid.");
    }
  }
}

// While Claude is working, check back sooner than the regular poll.
function pollSoonIfBusy() {
  clearTimeout(fastTimer);
  if (session && Object.values(session.jobs).some((j) => j.status === "running")) fastTimer = setTimeout(refresh, 800);
}

// The other person may take minutes or hours: tell the user when it is their move.
function signalTurn() {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Act: your turn", { body: session.title, tag: `act-${sessionId}` });
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}
function updateTitle() {
  document.title = session?.yourTurn ? `● Your turn · Act` : "Act — structured two-sided dialogue";
}

async function act(method, sub, body) {
  busy = true;
  try {
    session = await api(method, `/api/s/${sessionId}${sub}`, body, token);
    render();
    pollSoonIfBusy();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  } finally {
    busy = false;
  }
}

// ---------- home ----------

function renderHome(message, joinCode = "") {
  homeArgs = [message, joinCode];
  updateTitle();
  $app.innerHTML = `
    <h1>Act</h1>
    ${
      quickMode
        ? `<p class="muted">A way to settle one specific issue when talking directly isn't working. Not a judge. Not a therapist.
          Claude talks with each of you privately, proposes concrete answers, and each of you chooses in private.</p>`
        : `<p class="muted">A structured, two-sided way to work through a decision or disagreement. Not a judge. Not a therapist.
          Each person speaks privately first; the AI helps you build one shared picture of the problem and, if possible, one text you can both accept.</p>`
    }
    ${message ? `<div class="banner warn">${h(message)}</div>` : ""}
    <div class="card soft">
      <h3>Ground rules</h3>
      <ul class="tight small">
        ${
          quickMode
            ? `<li>What you tell Claude stays between you and Claude. The other person never sees your answers, Claude's summary of your side, your fallback, or your own wording of the question. They only see the neutral question and the options Claude proposes to both of you.</li>
              <li>Claude proposes; it never decides. Nothing is agreed until you both confirm the same option.</li>`
            : `<li>Your intake is private. The other person only sees what you mark as shareable, and only after you have approved it.</li>
              <li>The AI proposes; it never decides. Nothing counts as shared or agreed until you both explicitly accept it.</li>
              <li>Claims stay claims: disputed facts are recorded as each person's account, not as truth.</li>`
        }
        <li>${quickMode ? "An agreement, a clarified disagreement and no agreement are all legitimate outcomes." : "Full agreement, partial agreement, clarified disagreement and no agreement are all legitimate outcomes."} Either of you can pause or walk away at any time.</li>
        <li>This is not suitable for situations involving violence, threats, or coercion. Please seek professional help there.</li>
        <li>Content is processed by an AI model (Anthropic Claude) and stored on this server until either of you deletes the session, or after ${h(String(config.retentionDays || 30))} days of inactivity.</li>
        <li><b>Who can see the stored data:</b> this server is run by ${config.operator ? `<b>${h(config.operator)}</b>` : "whoever set it up"}. Like on any website, whoever runs the server can technically read everything stored here, including private answers. The app keeps things private between the two of you, but it cannot protect you from the person running it. Only continue if you trust them with that, or ask for it to be run by someone neutral.</li>
      </ul>
      <label class="row" style="font-weight:400"><input type="checkbox" data-k="consent" ${val("consent") ? "checked" : ""}> I understand and accept these ground rules.</label>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Start a new session</h3>
        ${
          config.quickOnly
            ? ""
            : `<div class="row">
          <button class="chip ${quickMode ? "on" : ""}" data-action="mode" data-mode="quick">Quick: settle one issue</button>
          <button class="chip ${quickMode ? "" : "on"}" data-action="mode" data-mode="full">Full process</button>
        </div>`
        }
        ${
          quickMode
            ? `<p class="small muted">For one specific thing that has to be settled soon (minutes to hours), when talking directly isn't working.
              Claude asks each of you privately what it needs to know, proposes concrete answers, and you each choose in private.</p>
              <label>The one issue to settle<span class="hint">e.g. "Who picks up the kids this Friday and when". Claude will rephrase it neutrally; the other person sees only that version.</span></label>
              <textarea data-k="new.question" rows="2" maxlength="2000">${h(val("new.question"))}</textarea>
              <label>Needs to be settled by <span class="hint">Optional</span></label>
              <input type="datetime-local" data-k="new.deadline" value="${h(val("new.deadline"))}">`
            : `<p class="small muted">For a whole decision or disagreement: shared problem map, options, and a single negotiated text.</p>
              <label>Topic<span class="hint">A short neutral title, e.g. "Where we spend the holidays"</span></label>
              <input type="text" data-k="new.title" value="${h(val("new.title"))}" maxlength="200">`
        }
        <label>Your first name</label>
        <input type="text" data-k="new.name" value="${h(val("new.name"))}" maxlength="60">
        <p><button class="primary" data-action="create">Create session</button></p>
      </div>
      <div class="card">
        <h3>Join with a code</h3>
        <label>Code</label>
        <input type="text" data-k="join.code" value="${h(val("join.code", joinCode))}" maxlength="20" style="text-transform:uppercase">
        <label>Your first name</label>
        <input type="text" data-k="join.name" value="${h(val("join.name"))}" maxlength="60">
        <p><button class="primary" data-action="join">Join session</button></p>
      </div>
    </div>
    ${renderKnownSessions()}`;
}

function renderKnownSessions() {
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("act:token:")) ids.push(k.slice(10));
    }
  } catch { /* storage unavailable */ }
  if (!ids.length) return "";
  return `<div class="card soft"><h3>Your sessions on this device</h3><ul class="tight">${ids
    .map((id) => `<li><a href="#/s/${h(id)}">${h(id)}</a></li>`)
    .join("")}</ul></div>`;
}

// ---------- session ----------

function render() {
  const s = session;
  if (!s) return;
  // Preserve focus and caret across re-renders.
  const active = document.activeElement;
  const focusKey = active?.dataset?.k;
  const sel = focusKey && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;

  const other = s.them?.name || "the other participant";
  const terminal = !!OUTCOMES[s.state];
  const quick = s.mode === "quick";
  updateTitle();
  $app.innerHTML = `
    <div class="row between">
      <a href="#/" class="small">← Act</a>
      <span class="small muted">You are <b>${h(s.me.name)}</b>${s.them ? ` · with <b>${h(s.them.name)}</b>` : ""}</span>
    </div>
    <h1>${h(s.title)}</h1>
    ${renderStepper(s)}
    ${s.paused ? `<div class="banner warn">Paused by ${h(s.names[s.paused.by])}${s.paused.reason ? `: “${h(s.paused.reason)}”` : ""}. Nothing can change until someone resumes. <button data-action="resume">Resume</button></div>` : ""}
    ${privateLink ? `<div class="banner info small"><b>Your private link.</b> Save it somewhere safe: it opens your side of this session on any device. Don't share it.<br>
      <input type="text" readonly value="${h(privateLink)}" onclick="this.select()"> <button class="link" data-action="hideLink">Done, hide this</button></div>` : ""}
    ${renderInvite(s)}
    ${quick && !terminal ? renderTurn(s, other) : ""}
    ${renderOutcomeProposal(s)}
    ${terminal ? (quick ? renderQuickFinal(s) : renderFinal(s)) : ""}
    ${quick ? renderQuickStage(s, other) : renderStage(s, other)}
    ${renderControls(s, terminal)}
    ${terminal ? "" : renderNotify(s)}
    <details class="card soft"><summary>Activity log</summary><ul class="tight small">${s.log
      .map((l) => `<li><span class="muted">${new Date(l.at).toLocaleString()}</span> — ${l.who ? h(s.names[l.who]) + " " : ""}${h(l.text)}</li>`)
      .join("")}</ul></details>`;

  if (focusKey) {
    const el = $app.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus();
      if (sel && "setSelectionRange" in el) try { el.setSelectionRange(...sel); } catch { /* not a text input */ }
    }
  }
}

function renderStepper(s) {
  const steps = s.mode === "quick" ? QUICK_STEPS : STEPS;
  const idx = steps.findIndex(([, states]) => states.includes(s.state));
  return `<div class="stepper">${steps.map(
    ([label], i) => `<span class="${i < idx ? "done" : i === idx ? "now" : ""}">${i + 1}. ${label}</span>`,
  ).join("")}</div>`;
}

function renderInvite(s) {
  if (s.them) return "";
  const link = `${location.origin}/#/join/${s.joinCode}`;
  return `<div class="banner info">
    <b>Invite the other participant.</b> Send them this code: <span class="code">${h(s.joinCode)}</span>
    or the link <a href="${h(link)}">${h(link)}</a>. The code works once. Meanwhile you can start your private intake.
  </div>`;
}

function jobState(key, runningText, retryAction) {
  const j = session.jobs[key];
  if (j?.status === "running") return spinner(runningText);
  if (j?.status === "error")
    return `<div class="banner bad">${h(j.error)} ${retryAction ? `<button data-action="${retryAction}">Retry</button>` : ""}</div>`;
  return "";
}

function renderStage(s, other) {
  switch (s.state) {
    case "CREATED":
    case "PRIVATE_INTAKE":
      return renderIntake(s, other);
    case "INTAKE_CONFIRMED":
      return `<h2>Building the shared problem map</h2>${jobState("map", "The AI is drafting a shared problem map from both confirmed intakes…", "genMap") || spinner("Starting…")}`;
    case "SHARED_MAP_PROPOSED":
      return renderMap(s, other, true);
    case "SHARED_MAP_CONFIRMED":
      return `${renderMap(s, other, false)}<h2>Options</h2>${jobState("options", "Generating options without picking a winner…", "genOptions") || spinner("Starting…")}`;
    case "OPTIONS_GENERATED":
      return `${renderOptions(s, other, true)}${collapsedMap(s, other)}`;
    case "SINGLE_TEXT_REVISION":
      return `${renderDraft(s, other)}${collapsedMap(s, other)}<details><summary>Options considered</summary>${renderOptions(s, other, false)}</details>`;
    default:
      return `${collapsedMap(s, other)}`;
  }
}

// ---------- 1. private intake ----------

function renderIntake(s, other) {
  const me = s.me;
  const them = s.them
    ? `${h(other)}: ${{ draft: "writing their intake", extracted: "reviewing their structured statements", confirmed: "has confirmed their statements" }[s.them.intakeStatus]}`
    : "The other participant has not joined yet.";
  let body;
  if (me.intakeStatus === "draft") body = renderIntakeForm(me);
  else if (me.intakeStatus === "extracted") body = renderStatements(me);
  else
    body = `<div class="banner ok">Your statements are confirmed. ${s.them?.intakeStatus === "confirmed" ? "" : `Waiting for ${h(other)} to confirm theirs.`}</div>
      ${renderStatementsReadOnly(me)}
      <p><button data-action="reopenIntake">Reopen my intake</button></p>`;
  return `
    <h2>1. Your private intake</h2>
    <p class="muted small">${them}</p>
    ${body}`;
}

function renderIntakeForm(me) {
  const running = session.jobs.extract?.status === "running";
  if (running) return spinner("The AI is structuring your intake into statements. Only you will see the result…");
  return `
    <div class="card">
      <p class="muted small">Only you can see this. For each answer choose what may later inform the shared stages:
      <b>verbatim</b> (may be quoted to the other person), <b>paraphrase</b> (may inform shared text in general terms, never quoted),
      or <b>private</b> (never leaves your view; not used in any shared step). Fields marked * are required.</p>
      ${FIELDS.map(
        ([k, label, hint]) => `
        <label>${label}${REQUIRED.includes(k) ? " *" : ""}<span class="hint">${hint}</span></label>
        <textarea data-k="intake.${k}" data-save="intake">${h(val(`intake.${k}`, me.intake[k]))}</textarea>
        <div class="row small"><span class="muted">Sharing:</span>
          <select data-k="sharing.${k}" data-save="intake">${Object.entries(SHARING)
            .map(([sk, sl]) => `<option value="${sk}" ${val(`sharing.${k}`, me.sharing[k]) === sk ? "selected" : ""}>${sl}</option>`)
            .join("")}</select></div>`,
      ).join("")}
      ${jobState("extract", "", "submitIntake")}
      <p class="row"><button class="primary" data-action="submitIntake">Structure my intake</button>
      <span class="muted small">Drafts save automatically.</span></p>
    </div>`;
}

function renderStatements(me) {
  const list = val("statements", null) || me.statements;
  return `
    ${me.safety ? `<div class="banner bad"><b>Please read:</b> ${h(me.safety)}<br>A negotiation process may not be the right tool here. You can pause or end at any time, and nothing is shared without your approval.</div>` : ""}
    <div class="card">
      <p class="muted small">The AI turned your intake into separate statements. <b>Correct anything that is wrong</b>: wording, category, and what may be shared.
      Facts you assert are recorded as your claims, not as established truth. Nothing is shared until you confirm.</p>
      ${me.clarifyingQuestions?.length ? `<div class="banner info small"><b>Questions that might strengthen your intake:</b><ul class="tight">${me.clarifyingQuestions.map((q) => `<li>${h(q)}</li>`).join("")}</ul>You can answer them by adding statements below, or by reopening your intake.</div>` : ""}
      <div>${list
        .map(
          (st, i) => `
        <div class="statement">
          <textarea aria-label="Statement ${i + 1} text" data-k="st.${i}.text" data-st="${i}" data-field="text" rows="2">${h(st.text)}</textarea>
          <div class="controls">
            <select aria-label="Statement ${i + 1} category" data-k="st.${i}.category" data-st="${i}" data-field="category">${Object.entries(CATEGORIES)
              .map(([k, l]) => `<option value="${k}" ${st.category === k ? "selected" : ""}>${l}</option>`)
              .join("")}</select>
            <select aria-label="Statement ${i + 1} sharing" data-k="st.${i}.sharing" data-st="${i}" data-field="sharing">${Object.entries(SHARING)
              .map(([k, l]) => `<option value="${k}" ${st.sharing === k ? "selected" : ""}>${l}</option>`)
              .join("")}</select>
            <button aria-label="Remove statement ${i + 1}" class="danger" data-action="delStatement" data-i="${i}" title="Remove">✕</button>
          </div>
        </div>`,
        )
        .join("")}</div>
      <p class="row">
        <button data-action="addStatement">+ Add statement</button>
        <button data-action="reopenIntake">Back to my intake</button>
        <button class="primary" data-action="confirmStatements">Approve and confirm</button>
      </p>
    </div>`;
}

function renderStatementsReadOnly(me) {
  return `<details class="card soft"><summary>Your confirmed statements (${me.statements.length})</summary>
    <ul class="tight small">${me.statements
      .map((st) => `<li>${badge(CATEGORIES[st.category])} ${badge(SHARING[st.sharing], st.sharing === "private" ? "bad" : st.sharing === "verbatim" ? "ok" : "")} ${h(st.text)}</li>`)
      .join("")}</ul></details>`;
}

// ---------- 2. shared map ----------

function renderMap(s, other, editable) {
  const m = s.map;
  if (!m) return "";
  const myDone = m.done[s.you];
  const theirDone = m.done[s.you === "A" ? "B" : "A"];
  const openCount = m.items.filter((i) => !i.yourVote && !i.superseded).length;
  return `
    <h2>2. Shared problem map</h2>
    <div class="card soft"><b>Proposed joint definition of the problem</b><p>${h(m.problemStatement)}</p></div>
    ${editable ? `<p class="muted small">Respond to each item separately. An item only becomes shared ground when you <b>both</b> accept the same wording.
      If you would accept different wording, choose “Accept with revision”: your wording becomes a new item for ${h(other)} to consider.
      You see ${h(other)}'s vote on an item only after casting yours.</p>` : ""}
    ${Object.entries(AREAS)
      .map(([area, [label, desc]]) => {
        const items = m.items.filter((i) => i.area === area);
        return `<div class="card area ${area}"><h3>${label} <span class="muted small">— ${desc}</span></h3>
          ${items.length ? items.map((i) => renderMapItem(s, i, editable, other)).join("") : `<p class="muted small">Nothing here.</p>`}
        </div>`;
      })
      .join("")}
    ${
      editable
        ? `<details class="card"><summary>Add a missing item</summary>
            <select data-k="add.area">${Object.entries(AREAS).map(([k, [l]]) => `<option value="${k}" ${val("add.area") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
            <textarea data-k="add.text" placeholder="Write it so that both of you could accept it, or so that it fairly describes both sides.">${h(val("add.text"))}</textarea>
            <p><button data-action="addMapItem">Add item</button></p>
          </details>
          ${jobState("map", "Regenerating…", null)}
          <div class="row between card">
            <span>${myDone ? `✔ You finished reviewing. ${theirDone ? "" : `Waiting for ${h(other)}.`}` : openCount ? `${openCount} item(s) still need your response.` : "All items answered."}
            ${theirDone ? `<br><span class="small muted">${h(other)} has finished reviewing.</span>` : ""}</span>
            <span class="row"><button data-action="genMap" title="Discard votes and let the AI propose a new map">Regenerate map</button>
            <button class="primary" data-action="mapDone" ${myDone || openCount ? "disabled" : ""}>I'm done reviewing</button></span>
          </div>`
        : ""
    }`;
}

function renderMapItem(s, i, editable, other) {
  const [statusLabel, statusKind] = ITEM_STATUS[i.status];
  const their = i.theirVote ? (i.theirVote.vote === "hidden" ? "voted (hidden until you vote)" : VOTES[i.theirVote.vote]) : "not voted yet";
  const k = `vote.${i.id}`;
  const pickingRevision = val(`${k}.mode`) === "revise";
  return `<div class="item ${i.superseded ? "superseded" : ""}">
    <div class="row between"><span>${i.revisionOf ? `<span class="muted small">Revision of ${h(i.revisionOf)} by ${h(s.names[i.origin])}:</span><br>` : i.origin !== "ai" ? `<span class="muted small">Added by ${h(s.names[i.origin])}:</span><br>` : ""}${h(i.text)}</span>
    ${i.superseded ? badge("Replaced by revision") : badge(statusLabel, statusKind)}</div>
    ${i.basis.length ? `<details class="small"><summary>Based on</summary><ul class="tight">${i.basis
      .map((b) => `<li>${b.id[0] === s.you ? "Your" : h(other) + "'s"} ${h(CATEGORIES[b.category]?.toLowerCase())}: ${b.text ? `“${h(b.text)}”` : `<i class="muted">(shared as paraphrase only)</i>`}</li>`)
      .join("")}</ul></details>` : ""}
    <p class="small muted">You: <b>${i.yourVote ? h(VOTES[i.yourVote.vote]) : "not voted"}</b>${i.yourVote?.revision ? ` (“${h(i.yourVote.revision)}”)` : ""} · ${h(other)}: <b>${h(their)}</b></p>
    ${
      editable && !i.superseded
        ? `<div class="row">${Object.entries(VOTES)
            .map(([v, l]) => `<button class="chip ${i.yourVote?.vote === v ? "on" : ""}" data-action="vote" data-item="${i.id}" data-vote="${v}">${l}</button>`)
            .join("")}</div>
          ${pickingRevision ? `<textarea data-k="${k}.text" placeholder="Your revised wording">${h(val(`${k}.text`, i.text))}</textarea>
            <p class="row"><button class="primary" data-action="submitRevision" data-item="${i.id}">Propose this wording</button><button data-action="cancelRevision" data-item="${i.id}">Cancel</button></p>` : ""}`
        : ""
    }
  </div>`;
}

function collapsedMap(s, other) {
  if (!s.map) return "";
  const confirmed = s.map.items.filter((i) => i.status === "confirmed" && !i.superseded);
  return `<details class="card soft"><summary>Shared problem map (${confirmed.length} item(s) accepted by both)</summary>${renderMap(s, other, false)}</details>`;
}

// ---------- 3. options ----------

function renderOptions(s, other, editable) {
  const items = s.options?.items || [];
  return `
    <h2>3. Options</h2>
    ${editable ? `<p class="muted small">These packages are generated without a winner. React to each, then choose one or more to build a single shared draft from. Your reactions are visible to ${h(other)}.</p>` : ""}
    ${items
      .map((o) => {
        const theirs = o.reactions[s.you === "A" ? "B" : "A"];
        return `<div class="card">
          <div class="row between"><h3 style="margin:0">${h(o.title)}</h3>
          ${editable ? `<label class="row" style="margin:0;font-weight:400"><input type="checkbox" data-k="opt.${o.id}" ${val(`opt.${o.id}`) ? "checked" : ""}> build from this</label>` : ""}</div>
          <p>${h(o.summary)}</p>
          <div class="row">${o.bases.map((b) => badge(BASES[b] || b, "accent")).join("")}</div>
          <h3>Terms</h3><ul class="tight">${o.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ul>
          <div class="grid2 small">
            <div><b>For ${h(s.names.A)}:</b> ${h(o.serves_a)}</div>
            <div><b>For ${h(s.names.B)}:</b> ${h(o.serves_b)}</div>
          </div>
          ${o.objective_criteria.length ? `<p class="small"><b>Objective criteria:</b> ${o.objective_criteria.map(h).join("; ")}</p>` : ""}
          ${o.open_questions.length ? `<p class="small"><b>Open questions:</b> ${o.open_questions.map(h).join("; ")}</p>` : ""}
          <div class="row small">${
            editable
              ? Object.entries(REACTIONS)
                  .map(([r, l]) => `<button class="chip ${o.reactions[s.you] === r ? "on" : ""}" data-action="react" data-option="${o.id}" data-reaction="${r}">${l}</button>`)
                  .join("")
              : `You: <b>${h(REACTIONS[o.reactions[s.you]] || "—")}</b>`
          }
          <span class="muted">· ${h(other)}: <b>${h(REACTIONS[theirs] || "no reaction yet")}</b></span></div>
        </div>`;
      })
      .join("")}
    ${
      editable
        ? `${jobState("options", "Generating a fresh set of options…", null)}${jobState("draft", "Writing draft 0 of the single text…", null)}
          <div class="row card"><button data-action="genOptions">Generate different options</button>
          <button class="primary" data-action="startDraft">Start single text from selected options</button></div>`
        : ""
    }`;
}

// ---------- 4. single text ----------

function renderDraft(s, other) {
  const d = s.draft;
  const v = d.versions.at(-1);
  const fb = d.yourFeedback;
  const revising = s.jobs.revise?.status === "running";
  const counts = { agreed: 0, open: 0, bracketed: 0 };
  v.clauses.forEach((c) => counts[c.status]++);
  const atLimit = d.rounds >= d.maxRounds && !revising;
  return `
    <h2>4. Single text — version ${v.n}</h2>
    <p class="muted small">One neutral working draft. Don't argue for or against the whole thing: for each clause say whether you can live with it,
    or what must change. Your responses are private; the AI merges both sides' changes into the next version and brackets what stays unresolved.
    Committing happens only when the whole text is accepted by both.</p>
    <div class="row">${badge(`${counts.agreed} agreed`, "ok")} ${badge(`${counts.open} open`, "warn")} ${badge(`${counts.bracketed} bracketed`, "bad")} ${badge(`version ${d.rounds} of max ${d.maxRounds}`)}</div>
    ${!d.improvable || atLimit ? `<div class="banner warn">${atLimit ? "The round limit is reached." : "The AI believes the remaining brackets are about preferences, not wording."} Consider closing with a partial agreement or a clarified disagreement (below), or continue if you see a way forward.</div>` : ""}
    <div class="card">
      ${v.preamble ? `<p><i>${h(v.preamble)}</i></p>` : ""}
      ${v.clauses
        .map((c, idx) => {
          const k = `fb.${v.n}.${c.id}`;
          const verdict = fb ? fb.clauses[c.id]?.verdict : val(`${k}.verdict`, c.status === "agreed" ? "ok" : null);
          return `<div class="clause ${c.status}">
            <div class="row between"><span class="text"><b>${idx + 1}.</b> ${h(c.text)}</span>
            ${badge({ agreed: "Agreed", open: "Open", bracketed: "Bracketed" }[c.status], { agreed: "ok", open: "warn", bracketed: "bad" }[c.status])}</div>
            ${c.bracketNote ? `<p class="small muted">Unresolved: ${h(c.bracketNote)}</p>` : ""}
            ${
              fb
                ? `<p class="small muted">Your response: <b>${verdict === "ok" ? "I can accept this" : `Must change — “${h(fb.clauses[c.id].text)}”`}</b></p>`
                : revising
                  ? ""
                  : `<div class="row">
                    <button class="chip ${verdict === "ok" ? "on" : ""}" data-action="clauseVerdict" data-k2="${k}" data-verdict="ok">I can accept this</button>
                    <button class="chip ${verdict === "change" ? "on" : ""}" data-action="clauseVerdict" data-k2="${k}" data-verdict="change">Must change</button></div>
                    ${verdict === "change" ? `<textarea data-k="${k}.text" placeholder="What must change, and why it matters to you">${h(val(`${k}.text`))}</textarea>` : ""}`
            }
          </div>`;
        })
        .join("")}
      ${
        fb
          ? `<div class="banner info">You responded to version ${v.n}. ${d.theyResponded ? "" : `Waiting for ${h(other)}.`}</div>`
          : revising
            ? ""
            : `<label>Anything missing or to add? <span class="hint">Optional. Leave empty if all clauses are complete.</span></label>
              <textarea data-k="fb.${v.n}.general">${h(val(`fb.${v.n}.general`))}</textarea>
              <p class="row"><button class="primary" data-action="submitFeedback">Send my response to version ${v.n}</button>
              <span class="small muted">If you both accept every clause and add nothing, the text becomes your full agreement.</span></p>`
      }
      ${revising ? spinner("Both have responded. The AI is merging your changes into the next version…") : jobState("revise", "", null)}
      ${d.theyResponded && !fb ? `<p class="small muted">${h(other)} has already responded to this version.</p>` : ""}
    </div>
    ${v.changeLog?.length ? `<div class="card soft small"><b>What changed in version ${v.n}</b><ul class="tight">${v.changeLog.map((l) => `<li>${h(l)}</li>`).join("")}</ul></div>` : ""}
    ${renderBatna(s)}
    ${d.versions.length > 1 ? `<details class="card soft"><summary>Earlier versions</summary>${d.versions
      .slice(0, -1)
      .reverse()
      .map((ov) => `<h3>Version ${ov.n}</h3><ol class="small">${ov.clauses.map((c) => `<li>${c.status === "bracketed" ? "[ " : ""}${h(c.text)}${c.status === "bracketed" ? " ]" : ""}</li>`).join("")}</ol>`)
      .join("")}</details>` : ""}`;
}

function renderBatna(s) {
  const b = s.me.batnaCheck;
  const current = s.draft.versions.at(-1).n;
  const verdicts = {
    draft_looks_better: ["The draft looks better than your alternative", "ok"],
    alternative_looks_better: ["Your alternative looks better than the draft", "bad"],
    unclear: ["Unclear", "warn"],
  };
  return `<div class="card">
    <div class="row between"><b>Private check: draft vs. your alternative</b>
    <button data-action="batna" ${s.jobs.batna?.status === "running" ? "disabled" : ""}>${b ? "Re-check" : "Check"}</button></div>
    <p class="small muted">Only you see this. Compares the current draft with what you said you would do without an agreement, so you don't agree at any cost, and don't walk away from something better.</p>
    ${jobState("batna", "Thinking about your alternative…", "batna")}
    ${
      b && b.version === current
        ? `<p>${badge(...verdicts[b.verdict])}</p><p>${h(b.assessment)}</p>${b.questions_to_consider.length ? `<ul class="tight small">${b.questions_to_consider.map((q) => `<li>${h(q)}</li>`).join("")}</ul>` : ""}`
        : ""
    }
  </div>`;
}

// ---------- quick mode ----------

function renderTurn(s, other) {
  if (s.paused || !s.them) return "";
  return s.yourTurn
    ? `<div class="banner ok"><b>● Your turn.</b></div>`
    : `<div class="banner info small">Nothing for you to do right now. This page updates by itself; you can leave it open or turn on notifications below.</div>`;
}

const topicSuggestion = `act-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => (b % 36).toString(36)).join("")}`;
function renderNotify(s) {
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return `<details class="card soft no-print"><summary>Get told when it's your turn</summary>
    <p class="small muted">The other person may answer in minutes or hours. Two options, neither sends any content of this session:</p>
    <p class="small"><b>This browser:</b> ${
      perm === "granted"
        ? "on (while this tab stays open)."
        : perm === "unsupported"
          ? "not supported here."
          : `<button data-action="browserNotify">Turn on browser notifications</button>`
    }</p>
    <p class="small"><b>Phone, via <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a>:</b> install the ntfy app, subscribe to a hard-to-guess topic name, and enter the same name here.
    The server then pings that topic with "It's your turn in Act." (Anyone who knows the topic name can read that ping, so make it long and random.)</p>
    <div class="row"><input type="text" data-k="notify.topic" value="${h(val("notify.topic", s.me.notify || ""))}" placeholder="e.g. ${h(topicSuggestion)}" style="max-width:320px">
    <button data-action="saveNotify">${s.me.notify ? "Update" : "Save"}</button></div>
  </details>`;
}

function renderQuickStage(s, other) {
  switch (s.state) {
    case "QUICK_FRAMING":
      return renderFraming(s, other);
    case "QUICK_INTERVIEW":
      return `${questionCard(s)}${renderInterview(s, other)}`;
    case "QUICK_OPTIONS":
      return `${questionCard(s)}${renderSealed(s, other)}`;
    case "QUICK_CONFIRM":
      return `${questionCard(s)}${renderQuickConfirm(s, other)}`;
    default:
      return renderQuickHistory(s);
  }
}

const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmtDeadline = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function questionCard(s) {
  const f = s.quick.framing;
  const dl = f.deadline;
  const late = dl && Date.parse(dl) < Date.now();
  return `<div class="card soft"><b>The question you agreed to settle</b><p style="font-size:1.1em">${h(f.text)}</p>
    ${dl ? `<p class="small ${late ? "" : "muted"}">${late ? "⚠ Deadline passed: " : "Settle by "}${h(fmtDeadline(dl))}</p>` : ""}</div>`;
}

function renderFraming(s, other) {
  const f = s.quick.framing;
  const j = s.jobs.frame;
  const mine = s.me.quick;
  const proposing = val("frame.mode") === "propose";
  let body;
  if (j?.status === "running") body = spinner("Claude is rephrasing the question neutrally…");
  else if (!f) body = jobState("frame", "", null) || spinner("Starting…");
  else {
    const accepted = f.acceptedBy[s.you];
    const theyAccepted = f.acceptedBy[s.you === "A" ? "B" : "A"];
    body = `<div class="card">
      <p class="small muted">Proposed by ${f.by === s.you ? "you" : h(s.names[f.by])}, neutrally rephrased by Claude${f.by === s.you ? ` from your wording (“${h(mine.frameRaw)}”, which only you can see)` : ""}:</p>
      <p style="font-size:1.15em"><b>${h(f.text)}</b></p>
      ${f.deadline ? `<p class="small">Settle by ${h(fmtDeadline(f.deadline))}</p>` : ""}
      ${f.note && f.by === s.you ? `<div class="banner info small">${h(f.note)}</div>` : ""}
      ${jobState("frame", "", null)}
      ${
        accepted
          ? `<div class="banner ok small">You accepted this question. ${s.them ? (theyAccepted ? "" : `Waiting for ${h(other)} to accept it or suggest other wording.`) : ""}</div>`
          : `<p class="small muted">Only this one question will be worked on. Anything else stays out of it and can be a separate session.</p>
            <div class="row"><button class="primary" data-action="acceptFrame">Accept this question</button>
            <button data-action="frameMode">Suggest different wording</button></div>`
      }
      ${
        proposing
          ? `<label>Your wording</label><textarea data-k="frame.text" rows="2">${h(val("frame.text", f.text))}</textarea>
            <label>Settle by <span class="hint">Optional</span></label><input type="datetime-local" data-k="frame.deadline" value="${h(val("frame.deadline", toLocalInput(f.deadline)))}">
            <p class="row"><button class="primary" data-action="proposeFrame">Propose</button><button data-action="frameCancel">Cancel</button></p>`
          : accepted
            ? `<p><button class="link" data-action="frameMode">Suggest different wording</button></p>`
            : ""
      }
    </div>`;
  }
  return `<h2>1. Agree the question</h2>${body}
    ${mine.status === "draft" ? `<h2>Meanwhile: prepare your answers</h2>${quickIntakeForm(s, false)}` : ""}`;
}

function quickIntakeForm(s, canStart) {
  const q = s.me.quick;
  return `<div class="card">
    <p class="small muted">Only you and Claude see this. Claude uses it, in paraphrased form, to propose answers; the other person never sees your words.
    Stick to the agreed question: anything else is set aside.</p>
    ${QUICK_FIELDS.map(
      ([k, label, hint]) => `<label>${label}<span class="hint">${hint}</span></label>
      <textarea data-k="qi.${k}" data-save="quick" rows="2">${h(val(`qi.${k}`, q.intake[k]))}</textarea>`,
    ).join("")}
    ${canStart ? `<p class="row"><button class="primary" data-action="startInterview">Send to Claude</button><span class="small muted">Drafts save automatically.</span></p>` : `<p class="small muted">Drafts save automatically. You can send them once you both accept the question.</p>`}
  </div>`;
}

function renderInterview(s, other) {
  const q = s.me.quick;
  const running = s.jobs.interview?.status === "running";
  const theirStatus = { draft: "hasn't started yet", interviewing: "is answering Claude's questions", review: "is checking Claude's summary", ready: "is ready" }[s.them?.quickStatus] || "";
  const gap = q.phase > 0;
  let body;
  if (q.status === "draft") body = quickIntakeForm(s, true);
  else if (running) body = spinner(gap ? "Claude is working out what might bridge the gap…" : "Claude is reading your answers…");
  else if (q.status === "interviewing") {
    body = `${jobState("interview", "", null)}
      ${q.questions.length ? `<div class="card">
        <p class="small muted">Claude needs a bit more to find something that could work. Short answers are fine. Only Claude sees them.</p>
        <ol>${q.questions.map((x) => `<li>${h(x)}</li>`).join("")}</ol>
        <textarea data-k="qa.${q.transcript.length}" rows="3" placeholder="Your answers">${h(val(`qa.${q.transcript.length}`))}</textarea>
        <p class="row"><button class="primary" data-action="answerQuick">Send answers</button>
        ${q.brief ? `<button data-action="quickReady" title="Claude works with what it has">Skip, use what I've said</button>` : ""}</p>
      </div>` : ""}`;
  } else if (q.status === "review") {
    const b = q.brief;
    body = `<div class="card">
      <p class="small muted">This is how Claude understood your side. It's never shown to ${h(other)}; it informs the options in paraphrased form. Is it right?</p>
      <ul class="tight">
        <li><b>You propose:</b> ${h(b.position)}</li>
        <li><b>You need:</b> ${h(b.needs)}</li>
        ${b.limits ? `<li><b>Your limits:</b> ${h(b.limits)}</li>` : ""}
        ${b.flexibility ? `<li><b>Where you have room:</b> ${h(b.flexibility)}</li>` : ""}
        ${b.facts.map((f) => `<li>${h(f)}</li>`).join("")}
      </ul>
      <p class="row"><button class="primary" data-action="quickReady">Yes, that's right</button></p>
      <label>Or correct something</label>
      <textarea data-k="qa.fix" rows="2">${h(val("qa.fix"))}</textarea>
      <p><button data-action="correctBrief">Send correction</button></p>
    </div>`;
  } else {
    body = `<div class="banner ok">You're ready. ${s.them?.quickStatus === "ready" ? "" : `Waiting for ${h(other)}.`}</div>
      ${jobState("qoptions", "Claude is writing concrete options for you both…", "genQuickOptions")}`;
  }
  return `<h2>2. Private interview${gap ? ` · follow-up ${q.phase}` : ""}</h2>
    ${gap ? `<div class="banner warn small">No option worked for both of you yet. Claude has a few follow-up questions to find something that could.</div>` : ""}
    <p class="muted small">${h(other)} ${h(theirStatus)}.</p>
    ${q.safety ? `<div class="banner bad"><b>Please read:</b> ${h(q.safety)}</div>` : ""}
    ${q.note ? `<div class="banner info small">${h(q.note)}</div>` : ""}
    ${body}
    ${q.transcript.length ? `<details class="card soft small"><summary>Your conversation with Claude</summary>${q.transcript
      .map((t) => (t.role === "ai" ? `<p><b>Claude:</b> ${t.questions.map(h).join(" ")}</p>` : `<p><b>You:</b> ${h(t.text)}</p>`))
      .join("")}</details>` : ""}`;
}

function optionCard(o, s, extra = "") {
  return `<div class="card">
    <h3 style="margin-top:0">${h(o.title)}</h3>
    <ul class="tight">${o.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ul>
    <p class="small muted">${h(o.rationale)}</p>
    <div class="grid2 small"><div><b>For ${h(s.names.A)}:</b> ${h(o.serves_a)}</div><div><b>For ${h(s.names.B)}:</b> ${h(o.serves_b)}</div></div>
    ${extra}
  </div>`;
}

function renderSealed(s, other) {
  const o = s.quick.options;
  const mine = o.yourMarks;
  return `<h2>3. Sealed choice · round ${o.round} of ${s.quick.maxRounds}</h2>
    ${o.exhausted ? `<div class="banner warn">No option worked for both of you in ${s.quick.maxRounds} rounds. Close below as a clarified disagreement (you both understand where you differ) or no agreement.</div>` : ""}
    <p class="small muted">Mark every option in private. ${h(other)} sees your marks only after sending theirs, and vice versa.
    If there's an option neither of you said “No” to, the one you both like most goes to a final confirmation.</p>
    ${o.items
      .map((it) => {
        const k = `mark.${o.round}.${it.id}`;
        const my = mine ? mine[it.id] : val(k);
        const theirs = o.theirMarks?.[it.id];
        return optionCard(
          it,
          s,
          `<div class="row small">${
            mine
              ? `You: ${badge(MARKS[my][0], MARKS[my][1])}`
              : Object.entries(MARKS).map(([m, [l]]) => `<button class="chip ${my === m ? "on" : ""}" data-action="mark" data-k2="${k}" data-mark="${m}">${l}</button>`).join("")
          }${theirs ? ` · ${h(other)}: ${badge(MARKS[theirs][0], MARKS[theirs][1])}` : ""}</div>`,
        );
      })
      .join("")}
    ${
      mine || o.exhausted
        ? `<div class="banner info small">${mine ? `Your choices are sealed. ${o.theyMarked ? "" : `Waiting for ${h(other)}.`}` : ""}</div>`
        : `<p class="row"><button class="primary" data-action="sendMarks">Send my choices (sealed)</button>${o.theyMarked ? `<span class="small muted">${h(other)} has already sent theirs.</span>` : ""}</p>`
    }
    ${renderQuickHistory(s, true)}`;
}

function renderQuickConfirm(s, other) {
  const c = s.quick.confirm;
  const opt = s.quick.options.items.find((i) => i.id === c.optionId);
  const theirs = s.quick.options.theirMarks;
  return `<h2>3. Final confirmation</h2>
    <div class="banner ok">You both said you could accept this. Confirm it as your agreement?</div>
    ${optionCard(opt, s, `<p class="small">You marked it ${badge(MARKS[s.quick.options.yourMarks[opt.id]][0])} · ${h(other)} marked it ${badge(MARKS[theirs[opt.id]][0])}</p>`)}
    ${
      c.you === null
        ? `<p class="row"><button class="primary" data-action="confirmQuick">Confirm: this is our agreement</button></p>
          <details class="card soft"><summary>Not after all</summary>
            <label>What's wrong with it? <span class="hint">Only Claude sees this; it uses it for follow-up questions.</span></label>
            <textarea data-k="decline.note" rows="2">${h(val("decline.note"))}</textarea>
            <p><button class="danger" data-action="declineQuick">Decline and keep looking</button></p>
          </details>`
        : `<div class="banner info small">You confirmed. ${c.them ? "" : `Waiting for ${h(other)}.`}</div>`
    }`;
}

function renderQuickHistory(s, collapsed = false) {
  const hist = s.quick.history.filter((r) => r.round !== s.quick.options?.round || OUTCOMES[s.state]);
  if (!hist.length) return "";
  const inner = hist
    .map(
      (r) => `<h3>Round ${r.round}${r.declined ? " (declined at confirmation)" : r.match ? "" : " (no overlap)"}</h3><ul class="tight small">${r.options
        .map((o) => `<li>${h(o.title)}: ${s.names.A} ${badge(MARKS[r.marks.A[o.id]][0], MARKS[r.marks.A[o.id]][1])} ${s.names.B} ${badge(MARKS[r.marks.B[o.id]][0], MARKS[r.marks.B[o.id]][1])}</li>`)
        .join("")}</ul>`,
    )
    .join("");
  return collapsed ? `<details class="card soft"><summary>Earlier rounds</summary>${inner}</details>` : `<div class="card soft">${inner}</div>`;
}

function renderQuickFinal(s) {
  const [label, desc] = OUTCOMES[s.state];
  const f = s.outcome.final;
  const kind = { FULL_AGREEMENT: "ok", CLARIFIED_DISAGREEMENT: "info", NO_AGREEMENT: "warn" }[s.state] || "info";
  const a = s.quick.agreement;
  return `<div class="banner ${kind}"><h2 style="margin:0">Outcome: ${label}</h2><p>${desc}</p>
    <p class="small">Closed ${new Date(f.at).toLocaleString()}${f.note ? ` · “${h(f.note)}”` : ""}</p></div>
    ${s.quick.framing ? `<div class="card"><b>Question</b><p>${h(s.quick.framing.text)}</p></div>` : ""}
    ${a && s.state === "FULL_AGREEMENT" ? `<div class="card"><h3>Agreed: ${h(a.title)}</h3><ol>${a.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ol>
      <p class="small muted">Confirmed by ${h(s.names.A)} and ${h(s.names.B)}.</p></div>` : ""}`;
}

// ---------- outcomes ----------

function renderOutcomeProposal(s) {
  const p = s.outcome?.proposal;
  if (!p) return "";
  const [label, desc] = OUTCOMES[p.type];
  if (p.by === s.you)
    return `<div class="banner info">You proposed to close as <b>${label}</b>. Waiting for ${h(s.them?.name)}. <button data-action="withdrawOutcome">Withdraw</button></div>`;
  return `<div class="banner info"><b>${h(s.names[p.by])}</b> proposes to close as <b>${label}</b> — ${desc}${p.note ? `<br>Note: “${h(p.note)}”` : ""}
    <p class="row"><button class="primary" data-action="acceptOutcome">Agree</button><button data-action="declineOutcome">Decline, continue</button></p></div>`;
}

function renderControls(s, terminal) {
  if (terminal) {
    return `<div class="row card no-print"><button data-action="print">Print / save as PDF</button><button class="danger" data-action="delete">Delete session data</button></div>`;
  }
  const canPartial = s.draft?.versions.at(-1).clauses.some((c) => c.status === "agreed");
  return `<details class="card no-print"><summary>Pause or close the process</summary>
    <p class="small muted">Any of these may be the right outcome. Partial agreement and clarified disagreement need ${h(s.them?.name || "the other participant")}'s consent;
    no agreement can be declared by either of you at any time.</p>
    <label>Optional note</label><textarea data-k="closeNote" placeholder="e.g. what you understand now, or why you are stopping">${h(val("closeNote"))}</textarea>
    <div class="row" style="margin-top:8px">
      ${s.paused ? "" : `<button data-action="pause">Pause</button>`}
      ${s.mode === "quick" ? "" : `<button data-action="proposeOutcome" data-type="PARTIAL_AGREEMENT" ${canPartial && s.them ? "" : "disabled title='Needs at least one clause both have agreed to'"}>Propose partial agreement</button>`}
      <button data-action="proposeOutcome" data-type="CLARIFIED_DISAGREEMENT" ${s.map || s.quick?.round ? "" : `disabled title='${s.mode === "quick" ? "Needs at least one round of options" : "Needs a shared problem map first"}'`}>Propose clarified disagreement</button>
      <button class="danger" data-action="noAgreement">End: no agreement</button>
      <button class="danger" data-action="delete">Delete session data</button>
    </div></details>`;
}

function renderFinal(s) {
  const [label, desc] = OUTCOMES[s.state];
  const f = s.outcome.final;
  const v = s.draft?.versions.at(-1);
  const agreed = v?.clauses.filter((c) => c.status === "agreed") || [];
  const unresolved = v?.clauses.filter((c) => c.status !== "agreed") || [];
  const map = s.map?.items.filter((i) => !i.superseded) || [];
  const listMap = (area, onlyConfirmed) =>
    map.filter((i) => i.area === area && (!onlyConfirmed || i.status === "confirmed")).map((i) => `<li>${h(i.text)}</li>`).join("");
  const kind = { FULL_AGREEMENT: "ok", PARTIAL_AGREEMENT: "ok", CLARIFIED_DISAGREEMENT: "info", NO_AGREEMENT: "warn" }[s.state];
  return `<div class="banner ${kind}"><h2 style="margin:0">Outcome: ${label}</h2><p>${desc}</p>
    <p class="small">Closed ${new Date(f.at).toLocaleString()}${f.by ? ` · confirmed by ${h(s.names[f.by])}` : ""}${f.note ? ` · “${h(f.note)}”` : ""}</p></div>
    ${s.map ? `<div class="card"><b>Joint problem definition</b><p>${h(s.map.problemStatement)}</p></div>` : ""}
    ${agreed.length && s.state !== "NO_AGREEMENT" ? `<div class="card"><h3>Agreed terms</h3><ol>${agreed.map((c) => `<li>${h(c.text)}</li>`).join("")}</ol></div>` : ""}
    ${unresolved.length && s.state !== "FULL_AGREEMENT" ? `<div class="card"><h3>Unresolved</h3><ul>${unresolved.map((c) => `<li>${h(c.text)}${c.bracketNote ? `<br><span class="small muted">${h(c.bracketNote)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
    ${s.map ? `<div class="card"><h3>Shared ground (accepted by both)</h3><ul>${listMap("common_ground", true) || "<li class='muted'>None recorded.</li>"}</ul>
      ${s.state === "CLARIFIED_DISAGREEMENT" || s.state === "NO_AGREEMENT" ? `<h3>Where you differ</h3><ul>${listMap("contested_facts", false)}${listMap("conflicting_preferences", false)}</ul>` : ""}</div>` : ""}`;
}

// ---------- events ----------

let saveTimer;
$app.addEventListener("input", (e) => {
  const el = e.target;
  const k = el.dataset.k;
  if (k) vals[k] = el.type === "checkbox" ? el.checked : el.value;
  if (el.dataset.st !== undefined) editStatement(Number(el.dataset.st), el.dataset.field, el.value);
  if (el.dataset.save === "intake") {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveIntake, 1200);
  }
  if (el.dataset.save === "quick") {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveQuickIntake, 1200);
  }
});

const collectQuickIntake = () => ({
  intake: Object.fromEntries(QUICK_FIELDS.map(([k]) => [k, val(`qi.${k}`, session.me.quick.intake[k])])),
});
async function saveQuickIntake() {
  clearTimeout(saveTimer);
  if (session?.me.quick?.status !== "draft") return;
  try {
    session = await api("PUT", `/api/s/${sessionId}/quick/intake`, collectQuickIntake(), token);
  } catch (e) {
    toast(e.message, true);
  }
}
$app.addEventListener("change", (e) => {
  // selects and checkboxes fire change, not always input
  const el = e.target;
  if (el.dataset.k) vals[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
  if (el.dataset.st !== undefined) editStatement(Number(el.dataset.st), el.dataset.field, el.value);
  if (el.dataset.save === "intake") saveIntake();
});

function editStatement(i, field, value) {
  const list = vals.statements || structuredClone(session.me.statements);
  list[i][field] = value;
  vals.statements = list;
}

function collectIntake() {
  const intake = {};
  const sharing = {};
  for (const [k] of FIELDS) {
    intake[k] = val(`intake.${k}`, session.me.intake[k]);
    sharing[k] = val(`sharing.${k}`, session.me.sharing[k]);
  }
  return { intake, sharing };
}

async function saveIntake() {
  clearTimeout(saveTimer);
  if (session?.me.intakeStatus !== "draft") return;
  try {
    session = await api("PUT", `/api/s/${sessionId}/intake`, collectIntake(), token);
  } catch (e) {
    toast(e.message, true);
  }
}

$app.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const a = btn.dataset.action;
  const d = btn.dataset;
  const s = session;
  switch (a) {
    case "mode":
      quickMode = config.quickOnly || d.mode === "quick";
      renderHome(...homeArgs);
      return;
    case "browserNotify":
      await Notification.requestPermission();
      render();
      return;
    case "saveNotify":
      if (await act("PUT", "/notify", { topic: val("notify.topic", s.me.notify || "") })) toast("Saved.");
      return;
    case "acceptFrame":
      await act("POST", "/quick/frame/accept");
      return;
    case "frameMode":
      vals["frame.mode"] = "propose";
      render();
      return;
    case "frameCancel":
      clearVals("frame.");
      render();
      return;
    case "proposeFrame": {
      const dl = val("frame.deadline", toLocalInput(s.quick.framing?.deadline));
      if (await act("POST", "/quick/frame", { question: val("frame.text", s.quick.framing?.text), deadline: dl ? new Date(dl).toISOString() : null })) clearVals("frame.");
      return;
    }
    case "startInterview":
      await saveQuickIntake();
      if (await act("POST", "/quick/start")) clearVals("qi.");
      return;
    case "answerQuick": {
      const k = `qa.${s.me.quick.transcript.length}`;
      if (await act("POST", "/quick/answer", { answer: val(k) })) clearVals(k);
      return;
    }
    case "correctBrief":
      if (await act("POST", "/quick/answer", { answer: val("qa.fix") })) clearVals("qa.fix");
      return;
    case "quickReady":
      await act("POST", "/quick/ready");
      return;
    case "genQuickOptions":
      await act("POST", "/quick/options");
      return;
    case "mark":
      vals[d.k2] = d.mark;
      render();
      return;
    case "sendMarks": {
      const o = s.quick.options;
      const marks = Object.fromEntries(o.items.map((i) => [i.id, val(`mark.${o.round}.${i.id}`, null)]));
      if (Object.values(marks).some((m) => !m)) return toast("Please mark every option.", true);
      if (await act("POST", "/quick/mark", { marks })) clearVals("mark.");
      return;
    }
    case "confirmQuick":
      await act("POST", "/quick/confirm", { accept: true });
      return;
    case "declineQuick":
      if (await act("POST", "/quick/confirm", { accept: false, note: val("decline.note") })) clearVals("decline.");
      return;
    case "create":
    case "join": {
      const deadline = val("new.deadline") ? new Date(val("new.deadline")).toISOString() : null;
      const body =
        a === "join"
          ? { code: val("join.code"), name: val("join.name"), consent: !!val("consent") }
          : quickMode
            ? { mode: "quick", question: val("new.question"), deadline, name: val("new.name"), consent: !!val("consent") }
            : { title: val("new.title"), name: val("new.name"), consent: !!val("consent") };
      try {
        const r = await api("POST", a === "create" ? "/api/sessions" : "/api/join", body);
        storage.set(tokenKey(r.id), r.token);
        clearVals("new.");
        clearVals("join.");
        location.hash = `#/s/${r.id}`;
        showPrivateLink(r.id, r.token);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case "submitIntake":
      await saveIntake();
      if (await act("POST", "/intake/submit")) clearVals("intake.");
      return;
    case "reopenIntake":
      delete vals.statements;
      await act("POST", "/intake/reopen");
      return;
    case "addStatement":
      vals.statements = [...(vals.statements || structuredClone(s.me.statements)), { text: "", category: "interest", sharing: "paraphrase", source: "interests" }];
      render();
      return;
    case "delStatement":
      vals.statements = (vals.statements || structuredClone(s.me.statements)).filter((_, i) => i !== Number(d.i));
      clearVals("st.");
      render();
      return;
    case "confirmStatements":
      if (vals.statements && !(await act("PUT", "/statements", { statements: vals.statements }))) return;
      delete vals.statements;
      clearVals("st.");
      await act("POST", "/statements/confirm");
      return;
    case "genMap":
      if (s.state === "SHARED_MAP_PROPOSED" && !confirm("Regenerating discards all votes on the current map. Continue?")) return;
      await act("POST", "/map/generate");
      return;
    case "vote":
      if (d.vote === "accept_with_revision") {
        vals[`vote.${d.item}.mode`] = "revise";
        render();
        return;
      }
      await act("POST", "/map/vote", { itemId: d.item, vote: d.vote });
      return;
    case "submitRevision":
      if (await act("POST", "/map/vote", { itemId: d.item, vote: "accept_with_revision", revision: val(`vote.${d.item}.text`) })) clearVals(`vote.${d.item}.`);
      return;
    case "cancelRevision":
      clearVals(`vote.${d.item}.`);
      render();
      return;
    case "addMapItem":
      if (await act("POST", "/map/add", { area: val("add.area", "common_ground"), text: val("add.text") })) clearVals("add.");
      return;
    case "mapDone":
      await act("POST", "/map/done");
      return;
    case "genOptions":
      await act("POST", "/options/generate");
      return;
    case "react":
      await act("POST", "/options/react", { optionId: d.option, reaction: d.reaction });
      return;
    case "startDraft": {
      const optionIds = s.options.items.filter((o) => val(`opt.${o.id}`)).map((o) => o.id);
      if (await act("POST", "/draft/start", { optionIds })) clearVals("opt.");
      return;
    }
    case "clauseVerdict":
      vals[`${d.k2}.verdict`] = d.verdict;
      render();
      return;
    case "submitFeedback": {
      const v = s.draft.versions.at(-1);
      const clauses = {};
      for (const c of v.clauses) {
        const k = `fb.${v.n}.${c.id}`;
        clauses[c.id] = { verdict: val(`${k}.verdict`, c.status === "agreed" ? "ok" : null), text: val(`${k}.text`) };
      }
      if (await act("POST", "/draft/feedback", { clauses, general: val(`fb.${v.n}.general`) })) clearVals(`fb.${v.n}.`);
      return;
    }
    case "batna":
      await act("POST", "/draft/batna");
      return;
    case "pause":
      await act("POST", "/pause", { reason: val("closeNote") });
      return;
    case "resume":
      await act("POST", "/resume");
      return;
    case "proposeOutcome":
      if (await act("POST", "/outcome/propose", { type: d.type, note: val("closeNote") })) clearVals("closeNote");
      return;
    case "noAgreement":
      if (!confirm("End the process with no agreement? This cannot be undone.")) return;
      await act("POST", "/outcome/propose", { type: "NO_AGREEMENT", note: val("closeNote") });
      return;
    case "acceptOutcome":
      await act("POST", "/outcome/respond", { accept: true });
      return;
    case "declineOutcome":
    case "withdrawOutcome":
      await act("POST", "/outcome/respond", { accept: false });
      return;
    case "hideLink":
      privateLink = null;
      render();
      return;
    case "print":
      window.print();
      return;
    case "delete":
      if (!confirm("Permanently delete this session and everything in it, for both participants?")) return;
      try {
        await api("DELETE", `/api/s/${sessionId}`, null, token);
        storage.del(tokenKey(sessionId));
        location.hash = "#/";
        toast("Session deleted.");
      } catch (err) {
        toast(err.message, true);
      }
      return;
  }
});

let privateLink = null;
function showPrivateLink(id, tok) {
  privateLink = `${location.origin}/#/s/${id}/${tok}`;
}
