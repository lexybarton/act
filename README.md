# Act

A two-sided structured communication tool. Two people each describe a decision, situation or disagreement **privately**; an AI (Claude) helps them build one shared picture of the problem, explore options, and iteratively improve **one neutral text** until they reach full agreement, partial agreement, clarified disagreement, or no agreement.

It is not an AI judge and not an AI therapist. The AI proposes, and nothing counts as shared or agreed until both people explicitly accept it.

## Run it

Requires Node 22+.

```bash
npm install
cp .env.example .env              # add your ANTHROPIC_API_KEY
npm start                         # http://localhost:3000
```

To try the whole flow without an API key, use canned AI output:

```bash
npm run mock
```

Open the app, create a session, and send the join code to the other person. To play both sides on one machine, open the join link in a private window. Tests (end-to-end API flow in mock mode): `npm test`.

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
- `src/store.js`: in-memory store with one JSON file per session under `data/`.
- `public/`: plain HTML/CSS/JS client with no build step. It polls every 3 s.
- `test/flow.test.js`: end-to-end tests of the state machine and the privacy guarantees.

## Known limitations (MVP)

- Two participants only. No accounts, email notifications, or real-time push (the client polls).
- Single-process storage in JSON files. Fine for a pilot; use a database for more than one server instance.
- Evidence is text only (no file uploads).
- Session data is stored unencrypted on the server. Anyone with server access can read it, so run it on infrastructure you trust.
- Prompt quality is untuned. Build a small eval set from real (consented) sessions before relying on it.
