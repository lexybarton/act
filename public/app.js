// Act client: hash routing, polling, and a full re-render from the server's per-participant view.
const $app = document.getElementById("app");

const FIELDS = [
  ["object", "Předmět", "O jakém rozhodnutí, situaci, plánu nebo vztahové otázce se jedná?"],
  ["observations", "Pozorování", "Co se stalo nebo co teď platí, z vašeho pohledu?"],
  ["position", "Postoj", "Jaký výsledek teď chcete?"],
  ["interests", "Zájmy", "Proč je pro vás ten výsledek důležitý? Jaké potřeby, obavy nebo hodnoty za ním stojí?"],
  ["concerns", "Obavy", "Čemu je potřeba se vyhnout?"],
  ["constraints", "Omezení", "Co se reálně změnit nedá?"],
  ["evidence", "Podklady", "Jaké informace podporují váš pohled?"],
  ["alternatives", "Alternativy", "Co uděláte, pokud se nedohodnete? (Obvykle je lepší nechat soukromé.)"],
];
const REQUIRED = ["object", "position", "interests"];
const CATEGORIES = {
  claimed_fact: "Tvrzený fakt",
  interpretation: "Interpretace",
  feeling: "Pocit / reakce",
  interest: "Zájem",
  constraint: "Omezení",
  requested_outcome: "Požadovaný výsledek",
  possible_concession: "Možný ústupek",
  uncertainty: "Nejistota",
};
const SHARING = {
  verbatim: "Sdílet doslova",
  paraphrase: "Jen v parafrázi",
  private: "Soukromé",
};
const AREAS = {
  common_ground: ["Společný základ", "Tvrzení, která můžete oba přijmout ve stejném významu."],
  compatible_interests: ["Slučitelné zájmy", "Různé potřeby, které lze možná naplnit zároveň."],
  contested_facts: ["Sporná fakta", "Neshodnete se, co se stalo nebo co je pravda."],
  conflicting_preferences: ["Protichůdné preference", "Fakta mohou být společná, ale chcete různé výsledky."],
};
const VOTES = {
  accept: "Přijímám",
  accept_with_revision: "Přijímám s úpravou",
  uncertain: "Nevím",
  reject: "Odmítám",
  not_important: "Není důležité",
};
const ITEM_STATUS = {
  confirmed: ["Přijato oběma", "ok"],
  rejected: ["Odmítnuto", "bad"],
  set_aside: ["Odloženo", ""],
  pending: ["Čeká na hlasy", "warn"],
  not_agreed: ["Nedohodnuto", "warn"],
};
const BASES = {
  shared_interests: "Společné zájmy",
  different_priorities: "Rozdílné priority",
  objective_criteria: "Objektivní kritéria",
  reciprocal_concessions: "Vzájemné ústupky",
  conditional_arrangement: "Podmíněné",
  reversible_experiment: "Vratná zkouška",
  alternatives_comparison: "Lepší než alternativy",
};
const REACTIONS = { promising: "Slibné", needs_work: "Potřebuje úpravy", unacceptable: "Nepřijatelné" };
const OUTCOMES = {
  FULL_AGREEMENT: ["Úplná dohoda", "Oba jste přijali všechny podstatné body."],
  PARTIAL_AGREEMENT: ["Částečná dohoda", "Dohodnuté body jsou zaznamenané; nevyřešené věci zůstávají výslovně otevřené."],
  CLARIFIED_DISAGREEMENT: ["Vyjasněná neshoda", "Oba rozumíte podstatě sporu, ale volíte odlišně."],
  NO_AGREEMENT: ["Bez dohody", "Alespoň jedna strana dává přednost své alternativě před jakoukoli nabízenou dohodou."],
};
const QUICK_STEPS = [
  ["Shoda na otázce", ["QUICK_FRAMING"]],
  ["Soukromý rozhovor", ["QUICK_INTERVIEW"]],
  ["Zapečetěná volba", ["QUICK_OPTIONS", "QUICK_CONFIRM"]],
  ["Výsledek", ["FULL_AGREEMENT", "PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT", "NO_AGREEMENT"]],
];
const QUICK_FIELDS = [
  ["need", "Co z toho potřebujete?", "Jedna nebo dvě věci, na kterých vám tu nejvíc záleží. *"],
  ["proposal", "Co navrhujete?", "Konkrétní odpověď: kdo, co, kdy, kde, kolik. *"],
  ["limits", "Co nemůžete přijmout?", "Pevné hranice a stručně proč."],
  ["fallback", "Váš plán B (soukromé)", "Co uděláte, pokud se to nevyřeší. Nikomu se to neukáže a nikdy se to nepoužije v návrzích; Claudovi to jen pomáhá pochopit, kolik máte prostoru."],
];
const MARKS = { prefer: ["Preferuji", "ok"], ok: ["Dokážu to přijmout", "warn"], no: ["Ne", "bad"] };
const STEPS = [
  ["Soukromý vstup", ["CREATED", "PRIVATE_INTAKE"]],
  ["Mapa problému", ["INTAKE_CONFIRMED", "SHARED_MAP_PROPOSED"]],
  ["Možnosti", ["SHARED_MAP_CONFIRMED", "OPTIONS_GENERATED"]],
  ["Společný text", ["SINGLE_TEXT_REVISION"]],
  ["Výsledek", ["FULL_AGREEMENT", "PARTIAL_AGREEMENT", "CLARIFIED_DISAGREEMENT", "NO_AGREEMENT"]],
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
  if (!res.ok) throw Object.assign(new Error(data.error || `Požadavek selhal (${res.status})`), { status: res.status });
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
    if (!token) return renderHome("Na tomto zařízení k této relaci nemáte přístup. Použijte svůj soukromý odkaz nebo kód pro připojení.");
    $app.innerHTML = spinner("Načítám…");
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
      renderHome(e.status === 404 ? "Tato relace už neexistuje." : "Váš přístup k této relaci není platný.");
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
      new Notification("Act: jste na řadě", { body: session.title, tag: `act-${sessionId}` });
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}
function updateTitle() {
  document.title = session?.yourTurn ? `● Jste na řadě · Act` : "Act — strukturovaný rozhovor dvou stran";
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
        ? `<p class="muted">Způsob, jak vyřešit jednu konkrétní věc, když přímá domluva nefunguje. Není to soudce ani terapeut.
          Claude mluví s každým z vás zvlášť, navrhne konkrétní řešení a každý z vás si v soukromí vybere.</p>`
        : `<p class="muted">Strukturovaný způsob, jak ve dvou projít rozhodnutí nebo neshodu. Není to soudce ani terapeut.
          Každý nejdřív mluví v soukromí; AI vám pomůže vytvořit společný obraz problému a pokud to jde, jeden text, který oba přijmete.</p>`
    }
    ${message ? `<div class="banner warn">${h(message)}</div>` : ""}
    <div class="card soft">
      <h3>Základní pravidla</h3>
      <ul class="tight small">
        ${
          quickMode
            ? `<li>Co řeknete Claudovi, zůstává mezi vámi a Claudem. Druhá strana nikdy neuvidí vaše odpovědi, Claudovo shrnutí vaší strany, váš plán B ani vaše původní znění otázky. Vidí jen neutrální otázku a možnosti, které Claude navrhne vám oběma.</li>
              <li>Claude navrhuje, nikdy nerozhoduje. Nic není dohodnuto, dokud oba nepotvrdíte stejnou možnost.</li>`
            : `<li>Váš vstup je soukromý. Druhá strana uvidí jen to, co označíte jako sdílitelné, a až poté, co to schválíte.</li>
              <li>AI navrhuje, nikdy nerozhoduje. Nic není sdílené ani dohodnuté, dokud to oba výslovně nepřijmete.</li>
              <li>Tvrzení zůstávají tvrzeními: sporná fakta se zaznamenávají jako pohled každého z vás, ne jako pravda.</li>`
        }
        <li>${quickMode ? "Dohoda, vyjasněná neshoda i žádná dohoda jsou legitimní výsledky." : "Úplná dohoda, částečná dohoda, vyjasněná neshoda i žádná dohoda jsou legitimní výsledky."} Kdokoli z vás může proces kdykoli pozastavit nebo odejít.</li>
        <li>Není to vhodné pro situace, kde jde o násilí, výhrůžky nebo nátlak. V takovém případě prosím vyhledejte odbornou pomoc.</li>
        <li>Obsah zpracovává AI model (Anthropic Claude) a je uložen na tomto serveru, dokud relaci jeden z vás nesmaže, nebo po ${h(String(config.retentionDays || 30))} dnech nečinnosti.</li>
        <li><b>Kdo vidí uložená data:</b> tento server provozuje ${config.operator ? `<b>${h(config.operator)}</b>` : "ten, kdo ho nastavil"}. Jako u každého webu může ten, kdo server provozuje, technicky přečíst vše, co je tu uloženo, včetně soukromých odpovědí. Aplikace drží věci v soukromí mezi vámi dvěma, ale nedokáže vás ochránit před tím, kdo ji provozuje. Pokračujte jen tehdy, pokud té osobě v tomhle důvěřujete, nebo požádejte, aby server provozoval někdo nestranný.</li>
      </ul>
      <label class="row" style="font-weight:400"><input type="checkbox" data-k="consent" ${val("consent") ? "checked" : ""}> Rozumím těmto pravidlům a přijímám je.</label>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Založit novou relaci</h3>
        ${
          config.quickOnly
            ? ""
            : `<div class="row">
          <button class="chip ${quickMode ? "on" : ""}" data-action="mode" data-mode="quick">Rychle: vyřešit jednu věc</button>
          <button class="chip ${quickMode ? "" : "on"}" data-action="mode" data-mode="full">Celý proces</button>
        </div>`
        }
        ${
          quickMode
            ? `<p class="small muted">Pro jednu konkrétní věc, kterou je potřeba brzy vyřešit (během minut až hodin), když přímá domluva nefunguje.
              Claude se každého z vás v soukromí zeptá na to, co potřebuje vědět, navrhne konkrétní řešení a každý si v soukromí vybere.</p>
              <label>Věc, kterou chcete vyřešit<span class="hint">Např. „Kdo tento pátek vyzvedne děti a kdy“. Claude ji přeformuluje neutrálně; druhá strana uvidí jen tuto verzi.</span></label>
              <textarea data-k="new.question" rows="2" maxlength="2000">${h(val("new.question"))}</textarea>
              <label>Vyřešit do <span class="hint">Nepovinné</span></label>
              <input type="datetime-local" data-k="new.deadline" value="${h(val("new.deadline"))}">`
            : `<p class="small muted">Pro celé rozhodnutí nebo neshodu: společná mapa problému, možnosti a jeden společně vyjednaný text.</p>
              <label>Téma<span class="hint">Krátký neutrální název, např. „Kde strávíme svátky“</span></label>
              <input type="text" data-k="new.title" value="${h(val("new.title"))}" maxlength="200">`
        }
        <label>Vaše křestní jméno</label>
        <input type="text" data-k="new.name" value="${h(val("new.name"))}" maxlength="60">
        <p><button class="primary" data-action="create">Založit relaci</button></p>
      </div>
      <div class="card">
        <h3>Připojit se kódem</h3>
        <label>Kód</label>
        <input type="text" data-k="join.code" value="${h(val("join.code", joinCode))}" maxlength="20" style="text-transform:uppercase">
        <label>Vaše křestní jméno</label>
        <input type="text" data-k="join.name" value="${h(val("join.name"))}" maxlength="60">
        <p><button class="primary" data-action="join">Připojit se</button></p>
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
  return `<div class="card soft"><h3>Vaše relace na tomto zařízení</h3><ul class="tight">${ids
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

  const other = s.them?.name || "druhá strana";
  const terminal = !!OUTCOMES[s.state];
  const quick = s.mode === "quick";
  updateTitle();
  $app.innerHTML = `
    <div class="row between">
      <a href="#/" class="small">← Act</a>
      <span class="small muted">Jste <b>${h(s.me.name)}</b>${s.them ? ` · druhá strana: <b>${h(s.them.name)}</b>` : ""}</span>
    </div>
    <h1>${h(s.title)}</h1>
    ${renderStepper(s)}
    ${s.paused ? `<div class="banner warn">Pozastaveno (${h(s.names[s.paused.by])})${s.paused.reason ? `: „${h(s.paused.reason)}“` : ""}. Dokud proces někdo neobnoví, nic se nezmění. <button data-action="resume">Obnovit</button></div>` : ""}
    ${privateLink ? `<div class="banner info small"><b>Váš soukromý odkaz.</b> Uložte si ho na bezpečné místo: otevře vaši stranu této relace na jakémkoli zařízení. Nikomu ho neposílejte.<br>
      <input type="text" readonly value="${h(privateLink)}" onclick="this.select()"> <button class="link" data-action="hideLink">Hotovo, skrýt</button></div>` : ""}
    ${renderInvite(s)}
    ${quick && !terminal ? renderTurn(s, other) : ""}
    ${renderOutcomeProposal(s)}
    ${terminal ? (quick ? renderQuickFinal(s) : renderFinal(s)) : ""}
    ${quick ? renderQuickStage(s, other) : renderStage(s, other)}
    ${renderControls(s, terminal)}
    ${terminal ? "" : renderNotify(s)}
    <details class="card soft"><summary>Průběh</summary><ul class="tight small">${s.log
      .map((l) => `<li><span class="muted">${new Date(l.at).toLocaleString("cs-CZ")}</span> — ${l.who ? h(s.names[l.who]) + " " : ""}${h(l.text)}</li>`)
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
    <b>Pozvěte druhou stranu.</b> Pošlete jí tento kód: <span class="code">${h(s.joinCode)}</span>
    nebo odkaz <a href="${h(link)}">${h(link)}</a>. Kód funguje jen jednou. Mezitím můžete začít vyplňovat svou část.
  </div>`;
}

function jobState(key, runningText, retryAction) {
  const j = session.jobs[key];
  if (j?.status === "running") return spinner(runningText);
  if (j?.status === "error")
    return `<div class="banner bad">${h(j.error)} ${retryAction ? `<button data-action="${retryAction}">Zkusit znovu</button>` : ""}</div>`;
  return "";
}

function renderStage(s, other) {
  switch (s.state) {
    case "CREATED":
    case "PRIVATE_INTAKE":
      return renderIntake(s, other);
    case "INTAKE_CONFIRMED":
      return `<h2>Tvorba společné mapy problému</h2>${jobState("map", "AI připravuje společnou mapu problému z obou potvrzených vstupů…", "genMap") || spinner("Spouštím…")}`;
    case "SHARED_MAP_PROPOSED":
      return renderMap(s, other, true);
    case "SHARED_MAP_CONFIRMED":
      return `${renderMap(s, other, false)}<h2>Možnosti</h2>${jobState("options", "Vytvářím možnosti bez určení vítěze…", "genOptions") || spinner("Spouštím…")}`;
    case "OPTIONS_GENERATED":
      return `${renderOptions(s, other, true)}${collapsedMap(s, other)}`;
    case "SINGLE_TEXT_REVISION":
      return `${renderDraft(s, other)}${collapsedMap(s, other)}<details><summary>Zvažované možnosti</summary>${renderOptions(s, other, false)}</details>`;
    default:
      return `${collapsedMap(s, other)}`;
  }
}

// ---------- 1. private intake ----------

function renderIntake(s, other) {
  const me = s.me;
  const them = s.them
    ? `${h(other)}: ${{ draft: "vyplňuje svůj vstup", extracted: "kontroluje svá strukturovaná tvrzení", confirmed: "má potvrzená tvrzení" }[s.them.intakeStatus]}`
    : "Druhá strana se zatím nepřipojila.";
  let body;
  if (me.intakeStatus === "draft") body = renderIntakeForm(me);
  else if (me.intakeStatus === "extracted") body = renderStatements(me);
  else
    body = `<div class="banner ok">Vaše tvrzení jsou potvrzená. ${s.them?.intakeStatus === "confirmed" ? "" : `Čekáme na druhou stranu (${h(other)}).`}</div>
      ${renderStatementsReadOnly(me)}
      <p><button data-action="reopenIntake">Znovu otevřít můj vstup</button></p>`;
  return `
    <h2>1. Váš soukromý vstup</h2>
    <p class="muted small">${them}</p>
    ${body}`;
}

function renderIntakeForm(me) {
  const running = session.jobs.extract?.status === "running";
  if (running) return spinner("AI rozděluje váš vstup na jednotlivá tvrzení. Výsledek uvidíte jen vy…");
  return `
    <div class="card">
      <p class="muted small">Tohle vidíte jen vy. U každé odpovědi zvolte, co smí později ovlivnit společné kroky:
      <b>doslova</b> (může být citováno druhé straně), <b>parafráze</b> (může obecně ovlivnit společný text, nikdy se necituje)
      nebo <b>soukromé</b> (zůstane jen u vás; nepoužije se v žádném společném kroku). Pole označená * jsou povinná.</p>
      ${FIELDS.map(
        ([k, label, hint]) => `
        <label>${label}${REQUIRED.includes(k) ? " *" : ""}<span class="hint">${hint}</span></label>
        <textarea data-k="intake.${k}" data-save="intake">${h(val(`intake.${k}`, me.intake[k]))}</textarea>
        <div class="row small"><span class="muted">Sdílení:</span>
          <select data-k="sharing.${k}" data-save="intake">${Object.entries(SHARING)
            .map(([sk, sl]) => `<option value="${sk}" ${val(`sharing.${k}`, me.sharing[k]) === sk ? "selected" : ""}>${sl}</option>`)
            .join("")}</select></div>`,
      ).join("")}
      ${jobState("extract", "", "submitIntake")}
      <p class="row"><button class="primary" data-action="submitIntake">Strukturovat můj vstup</button>
      <span class="muted small">Koncepty se ukládají automaticky.</span></p>
    </div>`;
}

function renderStatements(me) {
  const list = val("statements", null) || me.statements;
  return `
    ${me.safety ? `<div class="banner bad"><b>Přečtěte si prosím:</b> ${h(me.safety)}<br>Vyjednávání tu nemusí být vhodný nástroj. Kdykoli můžete proces pozastavit nebo ukončit a nic se nesdílí bez vašeho souhlasu.</div>` : ""}
    <div class="card">
      <p class="muted small">AI převedla váš vstup na samostatná tvrzení. <b>Opravte vše, co nesedí</b>: znění, kategorii i to, co se smí sdílet.
      Fakta, která tvrdíte, se zaznamenávají jako vaše tvrzení, ne jako ověřená pravda. Nic se nesdílí, dokud to nepotvrdíte.</p>
      ${me.clarifyingQuestions?.length ? `<div class="banner info small"><b>Otázky, které by mohly váš vstup posílit:</b><ul class="tight">${me.clarifyingQuestions.map((q) => `<li>${h(q)}</li>`).join("")}</ul>Odpovědět můžete přidáním tvrzení níže nebo opětovným otevřením vstupu.</div>` : ""}
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
            <button class="danger" data-action="delStatement" data-i="${i}" title="Odebrat">✕</button>
          </div>
        </div>`,
        )
        .join("")}</div>
      <p class="row">
        <button data-action="addStatement">+ Přidat tvrzení</button>
        <button data-action="reopenIntake">Zpět k mému vstupu</button>
        <button class="primary" data-action="confirmStatements">Schválit a potvrdit</button>
      </p>
    </div>`;
}

function renderStatementsReadOnly(me) {
  return `<details class="card soft"><summary>Vaše potvrzená tvrzení (${me.statements.length})</summary>
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
    <h2>2. Společná mapa problému</h2>
    <div class="card soft"><b>Navržená společná definice problému</b><p>${h(m.problemStatement)}</p></div>
    ${editable ? `<p class="muted small">Reagujte na každou položku zvlášť. Položka se stane společným základem, jen když <b>oba</b> přijmete stejné znění.
      Pokud byste přijali jiné znění, zvolte „Přijímám s úpravou“: vaše znění se stane novou položkou, ke které se vyjádří druhá strana (${h(other)}).
      Hlas druhé strany u položky uvidíte až po odevzdání svého.</p>` : ""}
    ${Object.entries(AREAS)
      .map(([area, [label, desc]]) => {
        const items = m.items.filter((i) => i.area === area);
        return `<div class="card area ${area}"><h3>${label} <span class="muted small">— ${desc}</span></h3>
          ${items.length ? items.map((i) => renderMapItem(s, i, editable, other)).join("") : `<p class="muted small">Nic tu není.</p>`}
        </div>`;
      })
      .join("")}
    ${
      editable
        ? `<details class="card"><summary>Přidat chybějící položku</summary>
            <select data-k="add.area">${Object.entries(AREAS).map(([k, [l]]) => `<option value="${k}" ${val("add.area") === k ? "selected" : ""}>${l}</option>`).join("")}</select>
            <textarea data-k="add.text" placeholder="Napište to tak, aby to mohli přijmout oba, nebo aby to férově popisovalo obě strany.">${h(val("add.text"))}</textarea>
            <p><button data-action="addMapItem">Přidat položku</button></p>
          </details>
          ${jobState("map", "Generuji znovu…", null)}
          <div class="row between card">
            <span>${myDone ? `✔ Kontrolu máte hotovou. ${theirDone ? "" : `Čekáme na druhou stranu (${h(other)}).`}` : openCount ? `Položky čekající na vaši reakci: ${openCount}.` : "Všechny položky mají odpověď."}
            ${theirDone ? `<br><span class="small muted">Druhá strana (${h(other)}) má kontrolu hotovou.</span>` : ""}</span>
            <span class="row"><button data-action="genMap" title="Zahodit hlasy a nechat AI navrhnout novou mapu">Vygenerovat mapu znovu</button>
            <button class="primary" data-action="mapDone" ${myDone || openCount ? "disabled" : ""}>Mám hotovo</button></span>
          </div>`
        : ""
    }`;
}

function renderMapItem(s, i, editable, other) {
  const [statusLabel, statusKind] = ITEM_STATUS[i.status];
  const their = i.theirVote ? (i.theirVote.vote === "hidden" ? "hlasováno (skryto, dokud nehlasujete)" : VOTES[i.theirVote.vote]) : "zatím nehlasováno";
  const k = `vote.${i.id}`;
  const pickingRevision = val(`${k}.mode`) === "revise";
  return `<div class="item ${i.superseded ? "superseded" : ""}">
    <div class="row between"><span>${i.revisionOf ? `<span class="muted small">Úprava položky ${h(i.revisionOf)} (${h(s.names[i.origin])}):</span><br>` : i.origin !== "ai" ? `<span class="muted small">Přidáno (${h(s.names[i.origin])}):</span><br>` : ""}${h(i.text)}</span>
    ${i.superseded ? badge("Nahrazeno úpravou") : badge(statusLabel, statusKind)}</div>
    ${i.basis.length ? `<details class="small"><summary>Vychází z</summary><ul class="tight">${i.basis
      .map((b) => `<li>${b.id[0] === s.you ? "Vy" : h(other)} – ${h(CATEGORIES[b.category]?.toLowerCase())}: ${b.text ? `„${h(b.text)}“` : `<i class="muted">(sdíleno jen jako parafráze)</i>`}</li>`)
      .join("")}</ul></details>` : ""}
    <p class="small muted">Vy: <b>${i.yourVote ? h(VOTES[i.yourVote.vote]) : "nehlasováno"}</b>${i.yourVote?.revision ? ` („${h(i.yourVote.revision)}“)` : ""} · ${h(other)}: <b>${h(their)}</b></p>
    ${
      editable && !i.superseded
        ? `<div class="row">${Object.entries(VOTES)
            .map(([v, l]) => `<button class="chip ${i.yourVote?.vote === v ? "on" : ""}" data-action="vote" data-item="${i.id}" data-vote="${v}">${l}</button>`)
            .join("")}</div>
          ${pickingRevision ? `<textarea data-k="${k}.text" placeholder="Vaše upravené znění">${h(val(`${k}.text`, i.text))}</textarea>
            <p class="row"><button class="primary" data-action="submitRevision" data-item="${i.id}">Navrhnout toto znění</button><button data-action="cancelRevision" data-item="${i.id}">Zrušit</button></p>` : ""}`
        : ""
    }
  </div>`;
}

function collapsedMap(s, other) {
  if (!s.map) return "";
  const confirmed = s.map.items.filter((i) => i.status === "confirmed" && !i.superseded);
  return `<details class="card soft"><summary>Společná mapa problému (přijato oběma: ${confirmed.length})</summary>${renderMap(s, other, false)}</details>`;
}

// ---------- 3. options ----------

function renderOptions(s, other, editable) {
  const items = s.options?.items || [];
  return `
    <h2>3. Možnosti</h2>
    ${editable ? `<p class="muted small">Tyto balíčky vznikly bez určení vítěze. Na každý zareagujte a pak vyberte jeden nebo více, ze kterých vznikne společný návrh. Vaše reakce uvidí i druhá strana (${h(other)}).</p>` : ""}
    ${items
      .map((o) => {
        const theirs = o.reactions[s.you === "A" ? "B" : "A"];
        return `<div class="card">
          <div class="row between"><h3 style="margin:0">${h(o.title)}</h3>
          ${editable ? `<label class="row" style="margin:0;font-weight:400"><input type="checkbox" data-k="opt.${o.id}" ${val(`opt.${o.id}`) ? "checked" : ""}> vycházet z této</label>` : ""}</div>
          <p>${h(o.summary)}</p>
          <div class="row">${o.bases.map((b) => badge(BASES[b] || b, "accent")).join("")}</div>
          <h3>Podmínky</h3><ul class="tight">${o.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ul>
          <div class="grid2 small">
            <div><b>${h(s.names.A)}:</b> ${h(o.serves_a)}</div>
            <div><b>${h(s.names.B)}:</b> ${h(o.serves_b)}</div>
          </div>
          ${o.objective_criteria.length ? `<p class="small"><b>Objektivní kritéria:</b> ${o.objective_criteria.map(h).join("; ")}</p>` : ""}
          ${o.open_questions.length ? `<p class="small"><b>Otevřené otázky:</b> ${o.open_questions.map(h).join("; ")}</p>` : ""}
          <div class="row small">${
            editable
              ? Object.entries(REACTIONS)
                  .map(([r, l]) => `<button class="chip ${o.reactions[s.you] === r ? "on" : ""}" data-action="react" data-option="${o.id}" data-reaction="${r}">${l}</button>`)
                  .join("")
              : `Vy: <b>${h(REACTIONS[o.reactions[s.you]] || "—")}</b>`
          }
          <span class="muted">· ${h(other)}: <b>${h(REACTIONS[theirs] || "zatím bez reakce")}</b></span></div>
        </div>`;
      })
      .join("")}
    ${
      editable
        ? `${jobState("options", "Vytvářím nové možnosti…", null)}${jobState("draft", "Píšu návrh 0 společného textu…", null)}
          <div class="row card"><button data-action="genOptions">Vytvořit jiné možnosti</button>
          <button class="primary" data-action="startDraft">Začít společný text z vybraných možností</button></div>`
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
    <h2>4. Společný text — verze ${v.n}</h2>
    <p class="muted small">Jeden neutrální pracovní návrh. Nehodnoťte ho jako celek: u každého bodu řekněte, zda ho dokážete přijmout,
    nebo co se musí změnit. Vaše odpovědi jsou soukromé; AI spojí změny obou stran do další verze a to, co zůstane nevyřešené, dá do závorek.
    Závazek vzniká, až když celý text přijmete oba.</p>
    <div class="row">${badge(`dohodnuto: ${counts.agreed}`, "ok")} ${badge(`otevřené: ${counts.open}`, "warn")} ${badge(`v závorkách: ${counts.bracketed}`, "bad")} ${badge(`verze ${d.rounds} z max. ${d.maxRounds}`)}</div>
    ${!d.improvable || atLimit ? `<div class="banner warn">${atLimit ? "Bylo dosaženo limitu kol." : "AI se domnívá, že zbývající závorky jsou o preferencích, ne o formulacích."} Zvažte uzavření částečnou dohodou nebo vyjasněnou neshodou (níže), případně pokračujte, pokud vidíte cestu dál.</div>` : ""}
    <div class="card">
      ${v.preamble ? `<p><i>${h(v.preamble)}</i></p>` : ""}
      ${v.clauses
        .map((c, idx) => {
          const k = `fb.${v.n}.${c.id}`;
          const verdict = fb ? fb.clauses[c.id]?.verdict : val(`${k}.verdict`, c.status === "agreed" ? "ok" : null);
          return `<div class="clause ${c.status}">
            <div class="row between"><span class="text"><b>${idx + 1}.</b> ${h(c.text)}</span>
            ${badge({ agreed: "Dohodnuto", open: "Otevřené", bracketed: "V závorkách" }[c.status], { agreed: "ok", open: "warn", bracketed: "bad" }[c.status])}</div>
            ${c.bracketNote ? `<p class="small muted">Nevyřešeno: ${h(c.bracketNote)}</p>` : ""}
            ${
              fb
                ? `<p class="small muted">Vaše odpověď: <b>${verdict === "ok" ? "Dokážu to přijmout" : `Musí se změnit — „${h(fb.clauses[c.id].text)}“`}</b></p>`
                : revising
                  ? ""
                  : `<div class="row">
                    <button class="chip ${verdict === "ok" ? "on" : ""}" data-action="clauseVerdict" data-k2="${k}" data-verdict="ok">Dokážu to přijmout</button>
                    <button class="chip ${verdict === "change" ? "on" : ""}" data-action="clauseVerdict" data-k2="${k}" data-verdict="change">Musí se změnit</button></div>
                    ${verdict === "change" ? `<textarea data-k="${k}.text" placeholder="Co se musí změnit a proč je to pro vás důležité">${h(val(`${k}.text`))}</textarea>` : ""}`
            }
          </div>`;
        })
        .join("")}
      ${
        fb
          ? `<div class="banner info">Vaše odpověď na verzi ${v.n} je odeslaná. ${d.theyResponded ? "" : `Čekáme na druhou stranu (${h(other)}).`}</div>`
          : revising
            ? ""
            : `<label>Chybí něco nebo chcete něco doplnit? <span class="hint">Nepovinné. Pokud jsou všechny body úplné, nechte prázdné.</span></label>
              <textarea data-k="fb.${v.n}.general">${h(val(`fb.${v.n}.general`))}</textarea>
              <p class="row"><button class="primary" data-action="submitFeedback">Odeslat mou odpověď na verzi ${v.n}</button>
              <span class="small muted">Pokud oba přijmete každý bod a nic nepřidáte, text se stane vaší úplnou dohodou.</span></p>`
      }
      ${revising ? spinner("Oba jste odpověděli. AI spojuje vaše změny do další verze…") : jobState("revise", "", null)}
      ${d.theyResponded && !fb ? `<p class="small muted">Druhá strana (${h(other)}) už na tuto verzi odpověděla.</p>` : ""}
    </div>
    ${v.changeLog?.length ? `<div class="card soft small"><b>Co se změnilo ve verzi ${v.n}</b><ul class="tight">${v.changeLog.map((l) => `<li>${h(l)}</li>`).join("")}</ul></div>` : ""}
    ${renderBatna(s)}
    ${d.versions.length > 1 ? `<details class="card soft"><summary>Dřívější verze</summary>${d.versions
      .slice(0, -1)
      .reverse()
      .map((ov) => `<h3>Verze ${ov.n}</h3><ol class="small">${ov.clauses.map((c) => `<li>${c.status === "bracketed" ? "[ " : ""}${h(c.text)}${c.status === "bracketed" ? " ]" : ""}</li>`).join("")}</ol>`)
      .join("")}</details>` : ""}`;
}

function renderBatna(s) {
  const b = s.me.batnaCheck;
  const current = s.draft.versions.at(-1).n;
  const verdicts = {
    draft_looks_better: ["Návrh vypadá lépe než vaše alternativa", "ok"],
    alternative_looks_better: ["Vaše alternativa vypadá lépe než návrh", "bad"],
    unclear: ["Nejasné", "warn"],
  };
  return `<div class="card">
    <div class="row between"><b>Soukromá kontrola: návrh vs. vaše alternativa</b>
    <button data-action="batna" ${s.jobs.batna?.status === "running" ? "disabled" : ""}>${b ? "Zkontrolovat znovu" : "Zkontrolovat"}</button></div>
    <p class="small muted">Vidíte jen vy. Porovná aktuální návrh s tím, co podle vás uděláte bez dohody, abyste nepřistoupili na dohodu za každou cenu ani neodešli od něčeho lepšího.</p>
    ${jobState("batna", "Přemýšlím o vaší alternativě…", "batna")}
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
    ? `<div class="banner ok"><b>● Jste na řadě.</b></div>`
    : `<div class="banner info small">Teď pro vás není nic k udělání. Stránka se aktualizuje sama; můžete ji nechat otevřenou nebo si níže zapnout upozornění.</div>`;
}

const topicSuggestion = `act-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => (b % 36).toString(36)).join("")}`;
function renderNotify(s) {
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return `<details class="card soft no-print"><summary>Upozornit mě, když budu na řadě</summary>
    <p class="small muted">Druhá strana může odpovědět za pár minut i za hodiny. Máte dvě možnosti, žádná z nich neposílá obsah této relace:</p>
    <p class="small"><b>Tento prohlížeč:</b> ${
      perm === "granted"
        ? "zapnuto (dokud zůstane tato karta otevřená)."
        : perm === "unsupported"
          ? "tady není podporováno."
          : `<button data-action="browserNotify">Zapnout upozornění v prohlížeči</button>`
    }</p>
    <p class="small"><b>Telefon přes <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a>:</b> nainstalujte aplikaci ntfy, přihlaste se k odběru těžko uhodnutelného tématu (topic) a stejný název zadejte sem.
    Server pak na toto téma pošle zprávu „Jste na řadě v Act.“ (Tu zprávu může číst kdokoli, kdo zná název tématu, proto ho zvolte dlouhý a náhodný.)</p>
    <div class="row"><input type="text" data-k="notify.topic" value="${h(val("notify.topic", s.me.notify || ""))}" placeholder="např. ${h(topicSuggestion)}" style="max-width:320px">
    <button data-action="saveNotify">${s.me.notify ? "Aktualizovat" : "Uložit"}</button></div>
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
const fmtDeadline = (d) => (d ? new Date(d).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" }) : "");

function questionCard(s) {
  const f = s.quick.framing;
  const dl = f.deadline;
  const late = dl && Date.parse(dl) < Date.now();
  return `<div class="card soft"><b>Otázka, kterou jste se dohodli vyřešit</b><p style="font-size:1.1em">${h(f.text)}</p>
    ${dl ? `<p class="small ${late ? "" : "muted"}">${late ? "⚠ Termín vypršel: " : "Vyřešit do "}${h(fmtDeadline(dl))}</p>` : ""}</div>`;
}

function renderFraming(s, other) {
  const f = s.quick.framing;
  const j = s.jobs.frame;
  const mine = s.me.quick;
  const proposing = val("frame.mode") === "propose";
  let body;
  if (j?.status === "running") body = spinner("Claude neutrálně přeformulovává otázku…");
  else if (!f) body = jobState("frame", "", null) || spinner("Spouštím…");
  else {
    const accepted = f.acceptedBy[s.you];
    const theyAccepted = f.acceptedBy[s.you === "A" ? "B" : "A"];
    body = `<div class="card">
      <p class="small muted">Návrh: ${f.by === s.you ? "vy" : h(s.names[f.by])}, neutrálně přeformuloval Claude${f.by === s.you ? ` z vašeho znění („${h(mine.frameRaw)}“, které vidíte jen vy)` : ""}:</p>
      <p style="font-size:1.15em"><b>${h(f.text)}</b></p>
      ${f.deadline ? `<p class="small">Vyřešit do ${h(fmtDeadline(f.deadline))}</p>` : ""}
      ${f.note && f.by === s.you ? `<div class="banner info small">${h(f.note)}</div>` : ""}
      ${jobState("frame", "", null)}
      ${
        accepted
          ? `<div class="banner ok small">Otázku máte přijatou. ${s.them ? (theyAccepted ? "" : `Čekáme, až ji druhá strana (${h(other)}) přijme nebo navrhne jiné znění.`) : ""}</div>`
          : `<p class="small muted">Řešit se bude jen tato jedna otázka. Vše ostatní zůstává stranou a může to být samostatná relace.</p>
            <div class="row"><button class="primary" data-action="acceptFrame">Přijmout tuto otázku</button>
            <button data-action="frameMode">Navrhnout jiné znění</button></div>`
      }
      ${
        proposing
          ? `<label>Vaše znění</label><textarea data-k="frame.text" rows="2">${h(val("frame.text", f.text))}</textarea>
            <label>Vyřešit do <span class="hint">Nepovinné</span></label><input type="datetime-local" data-k="frame.deadline" value="${h(val("frame.deadline", toLocalInput(f.deadline)))}">
            <p class="row"><button class="primary" data-action="proposeFrame">Navrhnout</button><button data-action="frameCancel">Zrušit</button></p>`
          : accepted
            ? `<p><button class="link" data-action="frameMode">Navrhnout jiné znění</button></p>`
            : ""
      }
    </div>`;
  }
  return `<h2>1. Shoda na otázce</h2>${body}
    ${mine.status === "draft" ? `<h2>Mezitím si připravte odpovědi</h2>${quickIntakeForm(s, false)}` : ""}`;
}

function quickIntakeForm(s, canStart) {
  const q = s.me.quick;
  return `<div class="card">
    <p class="small muted">Tohle vidíte jen vy a Claude. Claude to v parafrázované podobě použije k navržení řešení; druhá strana vaše slova nikdy neuvidí.
    Držte se dohodnuté otázky: vše ostatní se odkládá stranou.</p>
    ${QUICK_FIELDS.map(
      ([k, label, hint]) => `<label>${label}<span class="hint">${hint}</span></label>
      <textarea data-k="qi.${k}" data-save="quick" rows="2">${h(val(`qi.${k}`, q.intake[k]))}</textarea>`,
    ).join("")}
    ${canStart ? `<p class="row"><button class="primary" data-action="startInterview">Poslat Claudovi</button><span class="small muted">Koncepty se ukládají automaticky.</span></p>` : `<p class="small muted">Koncepty se ukládají automaticky. Odeslat je můžete, až oba přijmete otázku.</p>`}
  </div>`;
}

function renderInterview(s, other) {
  const q = s.me.quick;
  const running = s.jobs.interview?.status === "running";
  const theirStatus = { draft: "zatím nezačala", interviewing: "odpovídá na Claudovy otázky", review: "kontroluje Claudovo shrnutí", ready: "je připravená" }[s.them?.quickStatus] || "";
  const gap = q.phase > 0;
  let body;
  if (q.status === "draft") body = quickIntakeForm(s, true);
  else if (running) body = spinner(gap ? "Claude hledá, co by mohlo rozdíl překlenout…" : "Claude čte vaše odpovědi…");
  else if (q.status === "interviewing") {
    body = `${jobState("interview", "", null)}
      ${q.questions.length ? `<div class="card">
        <p class="small muted">Claude potřebuje vědět ještě něco, aby našel řešení, které by mohlo fungovat. Stačí krátké odpovědi. Vidí je jen Claude.</p>
        <ol>${q.questions.map((x) => `<li>${h(x)}</li>`).join("")}</ol>
        <textarea data-k="qa.${q.transcript.length}" rows="3" placeholder="Vaše odpovědi">${h(val(`qa.${q.transcript.length}`))}</textarea>
        <p class="row"><button class="primary" data-action="answerQuick">Odeslat odpovědi</button>
        ${q.brief ? `<button data-action="quickReady" title="Claude bude pracovat s tím, co už ví">Přeskočit, stačí to, co už Claude ví</button>` : ""}</p>
      </div>` : ""}`;
  } else if (q.status === "review") {
    const b = q.brief;
    body = `<div class="card">
      <p class="small muted">Takhle Claude pochopil vaši stranu. Druhá strana (${h(other)}) to nikdy neuvidí; do možností se to promítne jen v parafrázi. Sedí to?</p>
      <ul class="tight">
        <li><b>Navrhujete:</b> ${h(b.position)}</li>
        <li><b>Potřebujete:</b> ${h(b.needs)}</li>
        ${b.limits ? `<li><b>Vaše hranice:</b> ${h(b.limits)}</li>` : ""}
        ${b.flexibility ? `<li><b>Kde máte prostor:</b> ${h(b.flexibility)}</li>` : ""}
        ${b.facts.map((f) => `<li>${h(f)}</li>`).join("")}
      </ul>
      <p class="row"><button class="primary" data-action="quickReady">Ano, sedí to</button></p>
      <label>Nebo něco opravte</label>
      <textarea data-k="qa.fix" rows="2">${h(val("qa.fix"))}</textarea>
      <p><button data-action="correctBrief">Poslat opravu</button></p>
    </div>`;
  } else {
    body = `<div class="banner ok">Máte hotovo. ${s.them?.quickStatus === "ready" ? "" : `Čekáme na druhou stranu (${h(other)}).`}</div>
      ${jobState("qoptions", "Claude píše konkrétní možnosti pro vás oba…", "genQuickOptions")}`;
  }
  return `<h2>2. Soukromý rozhovor${gap ? ` · doplnění ${q.phase}` : ""}</h2>
    ${gap ? `<div class="banner warn small">Zatím žádná možnost nevyhovovala vám oběma. Claude má pár doplňujících otázek, aby našel něco, co by mohlo fungovat.</div>` : ""}
    <p class="muted small">Druhá strana (${h(other)}) ${h(theirStatus)}.</p>
    ${q.safety ? `<div class="banner bad"><b>Přečtěte si prosím:</b> ${h(q.safety)}</div>` : ""}
    ${q.note ? `<div class="banner info small">${h(q.note)}</div>` : ""}
    ${body}
    ${q.transcript.length ? `<details class="card soft small"><summary>Váš rozhovor s Claudem</summary>${q.transcript
      .map((t) => (t.role === "ai" ? `<p><b>Claude:</b> ${t.questions.map(h).join(" ")}</p>` : `<p><b>Vy:</b> ${h(t.text)}</p>`))
      .join("")}</details>` : ""}`;
}

function optionCard(o, s, extra = "") {
  return `<div class="card">
    <h3 style="margin-top:0">${h(o.title)}</h3>
    <ul class="tight">${o.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ul>
    <p class="small muted">${h(o.rationale)}</p>
    <div class="grid2 small"><div><b>${h(s.names.A)}:</b> ${h(o.serves_a)}</div><div><b>${h(s.names.B)}:</b> ${h(o.serves_b)}</div></div>
    ${extra}
  </div>`;
}

function renderSealed(s, other) {
  const o = s.quick.options;
  const mine = o.yourMarks;
  return `<h2>3. Zapečetěná volba · kolo ${o.round} z ${s.quick.maxRounds}</h2>
    ${o.exhausted ? `<div class="banner warn">Ani po ${s.quick.maxRounds} kolech nevyhovovala žádná možnost vám oběma. Níže proces uzavřete jako vyjasněnou neshodu (oba rozumíte, v čem se lišíte) nebo bez dohody.</div>` : ""}
    <p class="small muted">Každou možnost označte v soukromí. Druhá strana (${h(other)}) uvidí vaše označení až po odeslání svého, a naopak.
    Pokud existuje možnost, které ani jeden z vás neřekl „Ne“, ta, která se vám oběma líbí nejvíc, půjde k finálnímu potvrzení.</p>
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
              ? `Vy: ${badge(MARKS[my][0], MARKS[my][1])}`
              : Object.entries(MARKS).map(([m, [l]]) => `<button class="chip ${my === m ? "on" : ""}" data-action="mark" data-k2="${k}" data-mark="${m}">${l}</button>`).join("")
          }${theirs ? ` · ${h(other)}: ${badge(MARKS[theirs][0], MARKS[theirs][1])}` : ""}</div>`,
        );
      })
      .join("")}
    ${
      mine || o.exhausted
        ? `<div class="banner info small">${mine ? `Vaše volba je zapečetěná. ${o.theyMarked ? "" : `Čekáme na druhou stranu (${h(other)}).`}` : ""}</div>`
        : `<p class="row"><button class="primary" data-action="sendMarks">Odeslat mou volbu (zapečetěně)</button>${o.theyMarked ? `<span class="small muted">Druhá strana (${h(other)}) už svou volbu odeslala.</span>` : ""}</p>`
    }
    ${renderQuickHistory(s, true)}`;
}

function renderQuickConfirm(s, other) {
  const c = s.quick.confirm;
  const opt = s.quick.options.items.find((i) => i.id === c.optionId);
  const theirs = s.quick.options.theirMarks;
  return `<h2>3. Finální potvrzení</h2>
    <div class="banner ok">Oba jste uvedli, že tohle dokážete přijmout. Potvrdit to jako vaši dohodu?</div>
    ${optionCard(opt, s, `<p class="small">Vy: ${badge(MARKS[s.quick.options.yourMarks[opt.id]][0])} · ${h(other)}: ${badge(MARKS[theirs[opt.id]][0])}</p>`)}
    ${
      c.you === null
        ? `<p class="row"><button class="primary" data-action="confirmQuick">Potvrdit: tohle je naše dohoda</button></p>
          <details class="card soft"><summary>Nakonec ne</summary>
            <label>Co na tom nesedí? <span class="hint">Vidí to jen Claude; použije to pro doplňující otázky.</span></label>
            <textarea data-k="decline.note" rows="2">${h(val("decline.note"))}</textarea>
            <p><button class="danger" data-action="declineQuick">Odmítnout a hledat dál</button></p>
          </details>`
        : `<div class="banner info small">Potvrzeno. ${c.them ? "" : `Čekáme na druhou stranu (${h(other)}).`}</div>`
    }`;
}

function renderQuickHistory(s, collapsed = false) {
  const hist = s.quick.history.filter((r) => r.round !== s.quick.options?.round || OUTCOMES[s.state]);
  if (!hist.length) return "";
  const inner = hist
    .map(
      (r) => `<h3>Kolo ${r.round}${r.declined ? " (odmítnuto při potvrzení)" : r.match ? "" : " (bez shody)"}</h3><ul class="tight small">${r.options
        .map((o) => `<li>${h(o.title)}: ${s.names.A} ${badge(MARKS[r.marks.A[o.id]][0], MARKS[r.marks.A[o.id]][1])} ${s.names.B} ${badge(MARKS[r.marks.B[o.id]][0], MARKS[r.marks.B[o.id]][1])}</li>`)
        .join("")}</ul>`,
    )
    .join("");
  return collapsed ? `<details class="card soft"><summary>Dřívější kola</summary>${inner}</details>` : `<div class="card soft">${inner}</div>`;
}

function renderQuickFinal(s) {
  const [label, desc] = OUTCOMES[s.state];
  const f = s.outcome.final;
  const kind = { FULL_AGREEMENT: "ok", CLARIFIED_DISAGREEMENT: "info", NO_AGREEMENT: "warn" }[s.state] || "info";
  const a = s.quick.agreement;
  return `<div class="banner ${kind}"><h2 style="margin:0">Výsledek: ${label}</h2><p>${desc}</p>
    <p class="small">Uzavřeno ${new Date(f.at).toLocaleString("cs-CZ")}${f.note ? ` · „${h(f.note)}“` : ""}</p></div>
    ${s.quick.framing ? `<div class="card"><b>Otázka</b><p>${h(s.quick.framing.text)}</p></div>` : ""}
    ${a && s.state === "FULL_AGREEMENT" ? `<div class="card"><h3>Dohodnuto: ${h(a.title)}</h3><ol>${a.terms.map((t) => `<li>${h(t)}</li>`).join("")}</ol>
      <p class="small muted">Potvrdili: ${h(s.names.A)} a ${h(s.names.B)}.</p></div>` : ""}`;
}

// ---------- outcomes ----------

function renderOutcomeProposal(s) {
  const p = s.outcome?.proposal;
  if (!p) return "";
  const [label, desc] = OUTCOMES[p.type];
  if (p.by === s.you)
    return `<div class="banner info">Navrhli jste uzavřít proces jako <b>${label}</b>. Čekáme na druhou stranu (${h(s.them?.name)}). <button data-action="withdrawOutcome">Stáhnout návrh</button></div>`;
  return `<div class="banner info"><b>${h(s.names[p.by])}</b> navrhuje uzavřít proces jako <b>${label}</b> — ${desc}${p.note ? `<br>Poznámka: „${h(p.note)}“` : ""}
    <p class="row"><button class="primary" data-action="acceptOutcome">Souhlasím</button><button data-action="declineOutcome">Nesouhlasím, pokračovat</button></p></div>`;
}

function renderControls(s, terminal) {
  if (terminal) {
    return `<div class="row card no-print"><button data-action="print">Tisk / uložit jako PDF</button><button class="danger" data-action="delete">Smazat data relace</button></div>`;
  }
  const canPartial = s.draft?.versions.at(-1).clauses.some((c) => c.status === "agreed");
  return `<details class="card no-print"><summary>Pozastavit nebo uzavřít proces</summary>
    <p class="small muted">Kterýkoli z těchto výsledků může být ten správný. Částečná dohoda a vyjasněná neshoda vyžadují souhlas druhé strany${s.them ? ` (${h(s.them.name)})` : ""};
    ukončit bez dohody může kdokoli z vás kdykoli.</p>
    <label>Nepovinná poznámka</label><textarea data-k="closeNote" placeholder="např. čemu teď rozumíte, nebo proč končíte">${h(val("closeNote"))}</textarea>
    <div class="row" style="margin-top:8px">
      ${s.paused ? "" : `<button data-action="pause">Pozastavit</button>`}
      ${s.mode === "quick" ? "" : `<button data-action="proposeOutcome" data-type="PARTIAL_AGREEMENT" ${canPartial && s.them ? "" : "disabled title='Vyžaduje alespoň jeden bod, na kterém jste se oba dohodli'"}>Navrhnout částečnou dohodu</button>`}
      <button data-action="proposeOutcome" data-type="CLARIFIED_DISAGREEMENT" ${s.map || s.quick?.round ? "" : `disabled title='${s.mode === "quick" ? "Vyžaduje alespoň jedno kolo možností" : "Nejdřív je potřeba společná mapa problému"}'`}>Navrhnout vyjasněnou neshodu</button>
      <button class="danger" data-action="noAgreement">Ukončit bez dohody</button>
      <button class="danger" data-action="delete">Smazat data relace</button>
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
  return `<div class="banner ${kind}"><h2 style="margin:0">Výsledek: ${label}</h2><p>${desc}</p>
    <p class="small">Uzavřeno ${new Date(f.at).toLocaleString("cs-CZ")}${f.by ? ` · potvrzeno (${h(s.names[f.by])})` : ""}${f.note ? ` · „${h(f.note)}“` : ""}</p></div>
    ${s.map ? `<div class="card"><b>Společná definice problému</b><p>${h(s.map.problemStatement)}</p></div>` : ""}
    ${agreed.length && s.state !== "NO_AGREEMENT" ? `<div class="card"><h3>Dohodnuté body</h3><ol>${agreed.map((c) => `<li>${h(c.text)}</li>`).join("")}</ol></div>` : ""}
    ${unresolved.length && s.state !== "FULL_AGREEMENT" ? `<div class="card"><h3>Nevyřešeno</h3><ul>${unresolved.map((c) => `<li>${h(c.text)}${c.bracketNote ? `<br><span class="small muted">${h(c.bracketNote)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
    ${s.map ? `<div class="card"><h3>Společný základ (přijato oběma)</h3><ul>${listMap("common_ground", true) || "<li class='muted'>Nic nezaznamenáno.</li>"}</ul>
      ${s.state === "CLARIFIED_DISAGREEMENT" || s.state === "NO_AGREEMENT" ? `<h3>V čem se lišíte</h3><ul>${listMap("contested_facts", false)}${listMap("conflicting_preferences", false)}</ul>` : ""}</div>` : ""}`;
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
      if (await act("PUT", "/notify", { topic: val("notify.topic", s.me.notify || "") })) toast("Uloženo.");
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
      if (Object.values(marks).some((m) => !m)) return toast("Označte prosím každou možnost.", true);
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
          ? { code: val("join.code", homeArgs[1]), name: val("join.name"), consent: !!val("consent") }
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
      if (s.state === "SHARED_MAP_PROPOSED" && !confirm("Nové vygenerování zahodí všechny hlasy u aktuální mapy. Pokračovat?")) return;
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
      if (!confirm("Ukončit proces bez dohody? Tuto akci nelze vrátit.")) return;
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
      if (!confirm("Trvale smazat tuto relaci a vše v ní, pro oba účastníky?")) return;
      try {
        await api("DELETE", `/api/s/${sessionId}`, null, token);
        storage.del(tokenKey(sessionId));
        location.hash = "#/";
        toast("Relace smazána.");
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
