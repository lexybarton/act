# Act

A two-sided structured communication tool. Two people each describe a decision, situation or disagreement **privately**; an AI (Claude) helps them build one shared picture of the problem, explore options, and iteratively improve **one neutral text** until they reach full agreement, partial agreement, clarified disagreement, or no agreement.

It is not an AI judge and not an AI therapist. The AI proposes, and nothing counts as shared or agreed until both people explicitly accept it.

There are two modes:

- **Quick** (default): settle **one specific issue** within minutes to hours, for people whose direct communication is blocked by a wider conflict. Claude interviews each side privately, asking for whatever it needs, proposes concrete answers, and each person chooses in private. See [Quick mode](#quick-mode).
- **Full process**: work through a whole decision or disagreement with a shared problem map, options, and a single negotiated text. See [Flow](#flow).

## Run it

### 1. Install

Requires [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/lexybarton/act.git
cd act
npm install
```

### 2. Try it without an API key

Canned AI output lets you click through both modes for free:

```bash
npm run mock
```

Open http://localhost:3000. To play both people on one computer, create a session in one window and open the join link (shown at the top of the session) in a **private/incognito window**, so the two sides get separate storage.

### 3. Run it with Claude

Get an API key from https://console.anthropic.com, then:

```bash
cp .env.example .env      # then edit .env and set ANTHROPIC_API_KEY=...
npm start                 # http://localhost:3000
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Use `npm run dev` to restart automatically when you edit the code.

### 4. Let the other person reach it

`localhost` only works on your own computer. The other person needs a URL they can open:

- **Same Wi-Fi:** open `http://<your-computer's-LAN-IP>:3000`.
- **Anywhere, for a one-off session:** run a tunnel, for example `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`). Share the `https://…` URL it prints. Set `PUBLIC_URL` to that URL in `.env` so phone notifications link back to it.
- **Longer term:** deploy it to any Node host (Render, Fly.io, a small VPS). Keep `DATA_DIR` on persistent disk. Session data is stored unencrypted (see [limitations](#known-limitations-mvp)).

Then create a session and send the other person the **join code** or **join link**. This is the only message that has to pass between you, and a friend or mediator can pass it on.

### 5. Get told when it's your turn (optional)

Each person can set this up under **"Get told when it's your turn"** at the bottom of the session:

- **Browser notification:** works while the tab stays open. The tab title also shows `● Your turn`.
- **Phone push via [ntfy](https://ntfy.sh):** install the ntfy app, subscribe to a long random topic name, and enter the same name in Act. The server sends only "It's your turn in Act.", never session content. To use a self-hosted ntfy server, set `NTFY_URL`.

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required unless you run `npm run mock`. |
| `CLAUDE_MODEL` | `claude-opus-5` | Model for all AI steps. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `data` | One JSON file per session. |
| `RETENTION_DAYS` | `30` | Inactive sessions are deleted after this. |
| `MAX_ROUNDS` | `8` | Full mode: drafting round limit. |
| `QUICK_MAX_ROUNDS` | `3` | Quick mode: option rounds before closing is suggested. |
| `QUICK_ONLY` | off | Set to `1` to offer only quick mode (the full process is hidden and refused). |
| `OPERATOR` | none | Who runs this server. Shown in the ground rules, because whoever runs the server can read everything stored on it. |
| `NTFY_URL` | `https://ntfy.sh` | ntfy server for "your turn" pings. |
| `PUBLIC_URL` | none | Public address of this app, used as the link in pings. |

### Tests

```bash
npm test
```

These run end-to-end API tests of both modes in mock mode, including the privacy guarantees.

## Quick mode

For one concrete thing that has to be settled soon ("who picks up the kids on Friday and when", "how we split this month's electricity bill", "when the other person collects their things"), when talking directly isn't working.

| Step | State | What happens |
|---|---|---|
| Agree the question | `QUICK_FRAMING` | The creator describes the issue and can set a deadline. Claude rewrites it as **one neutral, concrete question**. If it bundles several issues, Claude narrows it to one and tells the author what it left out. The other person sees only the neutral version, never the original wording. Either person can propose different wording, and nothing starts until both accept the same question. |
| Private interview | `QUICK_INTERVIEW` | Each person answers 4 short prompts: *what I need*, *what I propose*, *what I can't accept*, and a **private fallback**. Claude then **hunts for what it still needs**: 1–3 targeted questions at a time (times, amounts, logistics, hard limits, what could be traded, how a disputed fact could be checked), up to 3 turns. Anything outside the question is acknowledged and set aside. Each person then checks Claude's summary of their side and corrects it if needed (or skips remaining questions). |
| Sealed choice | `QUICK_OPTIONS` | Claude writes 2–4 concrete, executable options: who does what, when, and what happens if it goes wrong. Each person marks every option **Prefer / Could live with it / No** in private. You see the other person's marks only after sending your own. |
| Gap round | back to `QUICK_INTERVIEW` | If no option is free of a "No", Claude goes back to **each person privately** with questions about what blocked them and what variation would work. It uses the other side's summary only to test bridging ideas, never quoting or attributing it. Then it writes a new round of options, up to `QUICK_MAX_ROUNDS`. |
| Confirm | `QUICK_CONFIRM` | The option both can live with, and like most together, goes to a final confirmation. Both confirming makes it a **full agreement**. A person who declines can say why (only Claude sees it), and a gap round follows. |
| Close | terminal | Full agreement, or after the round limit a **clarified disagreement** (needs both) or **no agreement** (either person, any time). |

Privacy in quick mode: the other person never sees your answers, your summary, your fallback, or your original wording of the question. The fallback never goes into any prompt that produces options. Summaries inform options only in paraphrased form. Pause, "no agreement", and deletion work as in full mode.

## Flow

| Stage | State | What happens |
|---|---|---|
| Private intake | `CREATED` → `PRIVATE_INTAKE` | Each person answers the 8 intake questions and sets a sharing level per answer: **verbatim**, **paraphrase**, or **private**. |
| Independent confirmation | `PRIVATE_INTAKE` | The AI splits the intake into categorized statements (claimed fact, interpretation, feeling, interest, constraint, requested outcome, possible concession, uncertainty), asks clarifying questions, and screens for safety concerns. Each person edits, recategorizes, re-labels sharing, adds or deletes statements, then approves. |
| Shared problem map | `INTAKE_CONFIRMED` → `SHARED_MAP_PROPOSED` | The AI proposes a neutral joint problem definition plus items in four areas: common ground, compatible interests, contested facts, conflicting preferences. |
| Common-ground validation | `SHARED_MAP_PROPOSED` | Each person votes on every item: Accept / Accept with revision / Uncertain / Reject / Not important. An item is shared only when **both** accept the same wording. A revision becomes a new item the other person must answer. |
| Options | `SHARED_MAP_CONFIRMED` → `OPTIONS_GENERATED` | 3–5 packages built on shared interests, differently ranked priorities, objective criteria, reciprocal concessions, conditional arrangements, reversible trials, and comparison with alternatives. No winner is picked. Both react (promising / needs work / unacceptable) and choose which ones to build from. |
| Single text | `SINGLE_TEXT_REVISION` | Draft 0 is written from the chosen options. Each round, each person marks every clause "I can accept this" or "Must change: …". The AI merges compatible changes, **brackets** conflicting ones with a neutral note, and logs what changed. A clause is *agreed* only when both OK'd it unchanged. |
| Outcome | `FULL_AGREEMENT` / `PARTIAL_AGREEMENT` / `CLARIFIED_DISAGREEMENT` / `NO_AGREEMENT` | Full agreement is automatic when both accept every clause as written. The printable record shows agreed terms, unresolved points, shared ground, and where the two differ. |

## Gaps in the original design, and how this version fills them

1. **Identity and access.** The design didn't say how two people join or how privacy is enforced. Here the creator shares a one-time join code (spent once used). Each person then gets a private secret token, kept in the browser and available as a private link for other devices. Every API call is authorized per person.
2. **Where "private" material may go.** Private statements never leave their author's view and are **never sent in any prompt that produces shared output**. Paraphrase-only statements may inform shared text but must not be quoted, and their provenance is hidden from the other person. The other person's intake, statements, draft feedback, and private checks are never included in your view (covered by tests).
3. **Anchoring and pressure in voting.** You only see the other person's vote on a map item after casting your own.
4. **Unclear "Accept with revision" semantics.** A revision becomes a new candidate, accepted by its author, which the other person must vote on. The original is marked superseded once both accept the revision.
5. **Missing items.** Either person can add an item the AI missed. "Regenerate map" is available but resets votes, with a warning.
6. **Contested facts blocking progress.** Options are told to prefer arrangements that don't require deciding who is right: verification procedures, conditional terms, or terms that work under either account.
7. **The BATNA is usually private.** "Alternatives" defaults to *private*, so it never reaches shared prompts. It is used in a **private check** during drafting, visible only to the person who asks: "is this draft better than your alternative?" This protects against agreement at any cost without revealing anyone's walk-away point.
8. **Accepting the whole text.** In single-text practice nobody commits until the package is complete. Here, both accepting every clause (and adding nothing) *is* the full agreement. There's no separate, premature "sign" step.
9. **Stop conditions.** "No longer improvable" is detected (the AI reports when the remaining brackets are about preferences, not wording), and there's a hard round limit (`MAX_ROUNDS`, default 8). Either one prompts both people to close as a partial agreement or clarified disagreement.
10. **Who can end the process, and how.** No agreement can be declared **unilaterally at any time**, since everyone may walk away. Partial agreement and clarified disagreement are joint statements and need the other person's consent. Partial agreement requires at least one clause both have agreed to.
11. **Deliberate pause.** Pause/Resume (with an optional reason) is a flag rather than a state, so it can happen at any stage without losing progress.
12. **Safety.** Negotiation is unsuitable where there is violence, coercion, or risk of harm. The intake extraction screens for this and shows a private notice to the affected person, and the ground rules state it up front.
13. **Consent and data retention.** Both people accept the ground rules (including that an AI processes their content) before starting. Either can delete the session. Inactive sessions are deleted after `RETENTION_DAYS` (default 30).
14. **Facts vs. claims.** Extraction phrases facts as the participant's claims. Prompts forbid turning allegations into facts, and the map attributes contested accounts to each person.
15. **Stalled or failed AI steps.** Every AI step runs as a background job with visible progress and a retry button on failure. Refusals and truncated responses are reported, never silently accepted.

## Architecture

- `src/server.js`: Express API; per-session routes authenticate by the `x-token` header.
- `src/flow.js`: session model, state machine, background jobs, and the per-participant **privacy-filtered view**.
- `src/llm.js`: all Claude calls (`claude-opus-5`, adaptive thinking, structured outputs validated with Zod, server-side refusal fallbacks), plus a mock mode.
- `src/notify.js`: opt-in "your turn" pings through ntfy (no session content).
- `src/store.js`: in-memory store with one JSON file per session under `data/`.
- `public/`: plain HTML/CSS/JS client with no build step. It polls every 3 s.
- `test/flow.test.js`: end-to-end tests of the state machine and the privacy guarantees.

## Known limitations (MVP)

- Two participants only. No accounts or email. The client polls (every 3 s, faster while Claude is working), and "your turn" pings are opt-in through the browser or ntfy.
- Quick-mode prompts are untuned, like the rest. The mock only exercises the flow, not the quality of Claude's questions or options.
- Single-process storage in JSON files. Fine for a pilot; use a database for more than one server instance.
- Evidence is text only (no file uploads).
- Session data is stored unencrypted on the server. Anyone with server access can read it, including private answers. If one of the two participants runs the server, they can read the other's private material; the ground rules say so, and name the operator when `OPERATOR` is set. Ideally a neutral person runs it.
- Prompt quality is untuned. Build a small eval set from real (consented) sessions before relying on it.
