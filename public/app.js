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
let busy = false;
// Values of inputs the user is editing, keyed by data-k, so polling re-renders never lose typing.
const vals = {};
const val = (k, fallback = "") => (k in vals ? vals[k] : fallback);
const clearVals = (prefix) => Object.keys(vals).forEach((k) => k.startsWith(prefix) && delete vals[k]);

// ---------- routing ----------

window.addEventListener("hashchange", route);
route();

function route() {
  clearInterval(pollTimer);
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
      session = v;
      render();
    }
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      clearInterval(pollTimer);
      storage.del(tokenKey(sessionId));
      renderHome(e.status === 404 ? "This session no longer exists." : "Your access to this session is not valid.");
    }
  }
}

async function act(method, sub, body) {
  busy = true;
  try {
    session = await api(method, `/api/s/${sessionId}${sub}`, body, token);
    render();
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
  $app.innerHTML = `
    <h1>Act</h1>
    <p class="muted">A structured, two-sided way to work through a decision or disagreement. Not a judge. Not a therapist.
    Each person speaks privately first; the AI helps you build one shared picture of the problem and, if possible, one text you can both accept.</p>
    ${message ? `<div class="banner warn">${h(message)}</div>` : ""}
    <div class="card soft">
      <h3>Ground rules</h3>
      <ul class="tight small">
        <li>Your intake is private. The other person only sees what you mark as shareable, and only after you have approved it.</li>
        <li>The AI proposes; it never decides. Nothing counts as shared or agreed until you both explicitly accept it.</li>
        <li>Claims stay claims: disputed facts are recorded as each person's account, not as truth.</li>
        <li>Full agreement, partial agreement, clarified disagreement and no agreement are all legitimate outcomes. Either of you can pause or walk away at any time.</li>
        <li>This is not suitable for situations involving violence, threats, or coercion. Please seek professional help there.</li>
        <li>Content is processed by an AI model (Anthropic Claude) and stored on this server until either of you deletes the session, or after 30 days of inactivity.</li>
      </ul>
      <label class="row" style="font-weight:400"><input type="checkbox" data-k="consent" ${val("consent") ? "checked" : ""}> I understand and accept these ground rules.</label>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Start a new session</h3>
        <label>Topic<span class="hint">A short neutral title, e.g. "Where we spend the holidays"</span></label>
        <input type="text" data-k="new.title" value="${h(val("new.title"))}" maxlength="200">
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
    ${renderOutcomeProposal(s)}
    ${terminal ? renderFinal(s) : ""}
    ${renderStage(s, other)}
    ${renderControls(s, terminal)}
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
  const idx = STEPS.findIndex(([, states]) => states.includes(s.state));
  return `<div class="stepper">${STEPS.map(
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
          <textarea data-k="st.${i}.text" data-st="${i}" data-field="text" rows="2">${h(st.text)}</textarea>
          <div class="controls">
            <select data-k="st.${i}.category" data-st="${i}" data-field="category">${Object.entries(CATEGORIES)
              .map(([k, l]) => `<option value="${k}" ${st.category === k ? "selected" : ""}>${l}</option>`)
              .join("")}</select>
            <select data-k="st.${i}.sharing" data-st="${i}" data-field="sharing">${Object.entries(SHARING)
              .map(([k, l]) => `<option value="${k}" ${st.sharing === k ? "selected" : ""}>${l}</option>`)
              .join("")}</select>
            <button class="danger" data-action="delStatement" data-i="${i}" title="Remove">✕</button>
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
      <button data-action="proposeOutcome" data-type="PARTIAL_AGREEMENT" ${canPartial && s.them ? "" : "disabled title='Needs at least one clause both have agreed to'"}>Propose partial agreement</button>
      <button data-action="proposeOutcome" data-type="CLARIFIED_DISAGREEMENT" ${s.map ? "" : "disabled title='Needs a shared problem map first'"}>Propose clarified disagreement</button>
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
});
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
    case "create":
    case "join": {
      const body =
        a === "create"
          ? { title: val("new.title"), name: val("new.name"), consent: !!val("consent") }
          : { code: val("join.code"), name: val("join.name"), consent: !!val("consent") };
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
