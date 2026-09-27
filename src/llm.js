// All model calls. Each function takes only the data a stage is allowed to see;
// private material is filtered out by the caller (see sharedStatements in flow.js).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const MOCK = process.env.LLM_MOCK === "1";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const client = MOCK ? null : new Anthropic();

export const STATEMENT_CATEGORIES = [
  "claimed_fact",
  "interpretation",
  "feeling",
  "interest",
  "constraint",
  "requested_outcome",
  "possible_concession",
  "uncertainty",
];
export const INTAKE_FIELDS = [
  "object",
  "observations",
  "position",
  "interests",
  "concerns",
  "constraints",
  "evidence",
  "alternatives",
];
export const MAP_AREAS = ["common_ground", "compatible_interests", "contested_facts", "conflicting_preferences"];
export const OPTION_BASES = [
  "shared_interests",
  "different_priorities",
  "objective_criteria",
  "reciprocal_concessions",
  "conditional_arrangement",
  "reversible_experiment",
  "alternatives_comparison",
];

const PRINCIPLES = `You support a structured two-party communication process based on principled negotiation (separate people from the problem, focus on interests not positions, invent options for mutual gain, use objective criteria) and the single-text procedure.

Hard rules:
- You are not a judge and not a therapist. Never decide who is right, never diagnose anyone, never assign blame.
- Never convert an allegation or interpretation into an established fact. Attribute contested claims to the person who made them ("<name> reports that...").
- Use neutral, concrete, non-inflammatory language. Describe behaviour and needs, not character.
- Never invent facts, interests, or commitments that the participants did not express. When something is unclear, say so.
- Agreement is not the goal in itself. Clarified disagreement or no agreement are legitimate outcomes.
- Write in the language the participants used.`;

const PRIVACY_RULES = `Privacy: each input statement is labelled VERBATIM (may be quoted) or PARAPHRASE (may inform your output, but must never be quoted or closely reproduced; refer to it only in generalized form). Material the participants kept private has been removed and must not be guessed at.`;

async function call({ system, prompt, schema, effort = "high" }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("The AI declined to process this content. Please rephrase and try again.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The AI response was cut off. Please try again, or shorten the input.");
  }
  if (!response.parsed_output) throw new Error("The AI returned an unreadable response. Please retry.");
  return response.parsed_output;
}

const fmtStatements = (label, statements) =>
  statements.length
    ? statements.map((st) => `[${st.id}] (${label}, ${st.category}, ${st.sharing.toUpperCase()}) ${st.text}`).join("\n")
    : `(no shareable statements from ${label})`;

// ---------- 1. Private extraction ----------

const ExtractionSchema = z.object({
  statements: z.array(
    z.object({
      category: z.enum(STATEMENT_CATEGORIES),
      text: z.string(),
      source_field: z.enum(INTAKE_FIELDS),
    }),
  ),
  clarifying_questions: z.array(z.string()),
  safety: z.object({
    concern: z.boolean(),
    note: z.string(),
  }),
});

export async function extract({ title, name, intake }) {
  if (MOCK) return mockExtract(intake);
  const fields = INTAKE_FIELDS.map((f) => `## ${f}\n${intake[f]?.trim() || "(left blank)"}`).join("\n\n");
  return call({
    system: `${PRINCIPLES}\n\nYou are processing ONE participant's private intake. Only this participant sees your output; they will correct and approve it.`,
    prompt: `Topic of the process: "${title}"
Participant: ${name}

Their intake:
${fields}

Convert this into atomic, structured statements, each in one category:
- claimed_fact: something the participant asserts happened or is true. Phrase it as their claim ("I say that..." or a plain statement they could stand behind), never as verified truth.
- interpretation: their reading of motives, meaning, or causes.
- feeling: emotional reactions.
- interest: the need, fear, motivation or value underneath a position.
- constraint: what cannot realistically change.
- requested_outcome: what they want to happen (positions).
- possible_concession: anything they signal they could give, trade, or be flexible on.
- uncertainty: things they are unsure about or do not know.

Write statements in first person from ${name}'s perspective, keep their meaning, do not soften or sharpen it. Split compound sentences. Separate facts from interpretations even when the participant mixed them. Do not add interests they did not express; if an interest seems implied but unstated, put a question in clarifying_questions instead.

clarifying_questions: up to 4 short questions that would make the intake more useful (e.g. missing interests behind a position, vague constraints, unclear alternatives).

safety: set concern=true only if the intake suggests violence, threats, coercion, stalking, abuse, or risk of self-harm, where a negotiation process could be unsafe. In that case note gently why, and that professional or emergency help may be more appropriate. Otherwise concern=false and note="".`,
    schema: ExtractionSchema,
  });
}

function mockExtract(intake) {
  const catFor = {
    object: "claimed_fact",
    observations: "claimed_fact",
    position: "requested_outcome",
    interests: "interest",
    concerns: "interest",
    constraints: "constraint",
    evidence: "claimed_fact",
    alternatives: "uncertainty",
  };
  const statements = [];
  for (const f of INTAKE_FIELDS) {
    for (const part of (intake[f] || "").split(/(?<=[.!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean)) {
      statements.push({ category: catFor[f], text: part, source_field: f });
    }
  }
  return {
    statements,
    clarifying_questions: ["[mock] What would change for you if your position were fully met?"],
    safety: { concern: false, note: "" },
  };
}

// ---------- 2. Shared problem map ----------

const MapSchema = z.object({
  problem_statement: z.string(),
  items: z.array(
    z.object({
      area: z.enum(MAP_AREAS),
      text: z.string(),
      refs: z.array(z.string()),
    }),
  ),
});

export async function buildMap({ title, names, a, b }) {
  if (MOCK) return mockMap(names, a, b);
  return call({
    system: `${PRINCIPLES}\n\n${PRIVACY_RULES}\n\nBoth participants will see and vote on everything you produce.`,
    prompt: `Topic: "${title}"

Confirmed, shareable statements from ${names.A}:
${fmtStatements(names.A, a)}

Confirmed, shareable statements from ${names.B}:
${fmtStatements(names.B, b)}

Build a shared problem map with four strictly separated areas:
- common_ground: statements both could plausibly accept with the SAME meaning. Phrase each so both could sign it. Semantic similarity is only a candidate: be conservative; do not paper over differences.
- compatible_interests: different interests or requests that could be satisfied together. Name both sides' interests and why they are compatible.
- contested_facts: points where their accounts of what happened or what is true differ. Present both accounts side by side, attributed, without judging.
- conflicting_preferences: facts may be accepted, but desired outcomes differ. State each preference and the interest behind it where known.

Each item must be one clear, self-contained sentence or two. refs = the ids of statements the item is based on (e.g. ["A3","B1"]).

problem_statement: a neutral joint definition of the problem, written as a question both could want answered ("How can we ... while ...?"). It must not presuppose any side's position.`,
    schema: MapSchema,
  });
}

function mockMap(names, a, b) {
  const pick = (arr, cat) => arr.find((s) => s.category === cat);
  const items = [
    { area: "common_ground", text: `Both ${names.A} and ${names.B} want to resolve this topic. [mock]`, refs: [] },
  ];
  const ia = pick(a, "interest");
  const ib = pick(b, "interest");
  if (ia && ib) items.push({ area: "compatible_interests", text: `${names.A}: "${ia.text}" / ${names.B}: "${ib.text}" [mock]`, refs: [ia.id, ib.id] });
  const fa = pick(a, "claimed_fact");
  const fb = pick(b, "claimed_fact");
  if (fa && fb) items.push({ area: "contested_facts", text: `${names.A} reports: ${fa.text} — ${names.B} reports: ${fb.text} [mock]`, refs: [fa.id, fb.id] });
  const ra = pick(a, "requested_outcome");
  const rb = pick(b, "requested_outcome");
  if (ra && rb) items.push({ area: "conflicting_preferences", text: `${names.A} wants: ${ra.text} — ${names.B} wants: ${rb.text} [mock]`, refs: [ra.id, rb.id] });
  return { problem_statement: "How can both participants' core interests be met? [mock]", items };
}

// ---------- 3. Options ----------

const OptionsSchema = z.object({
  options: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      terms: z.array(z.string()),
      bases: z.array(z.enum(OPTION_BASES)),
      serves_a: z.string(),
      serves_b: z.string(),
      objective_criteria: z.array(z.string()),
      open_questions: z.array(z.string()),
    }),
  ),
});

export async function generateOptions({ title, names, problemStatement, mapItems, a, b }) {
  if (MOCK) return mockOptions(names);
  const map = mapItems.map((i) => `- (${i.area}; ${i.status}) ${i.text}`).join("\n");
  return call({
    system: `${PRINCIPLES}\n\n${PRIVACY_RULES}\n\nBoth participants will see every option. Do not rank the options or pick a winner.`,
    prompt: `Topic: "${title}"
Joint problem definition: ${problemStatement}

Shared problem map (status shows whether both participants accepted the item's wording):
${map}

Shareable statements from ${names.A}:
${fmtStatements(names.A, a)}

Shareable statements from ${names.B}:
${fmtStatements(names.B, b)}

Generate 3 to 5 genuinely different option packages. Across the set, draw on:
- shared_interests: build on what both want.
- different_priorities: trade across issues the two value differently instead of splitting every difference.
- objective_criteria: fair standards, precedents, expert norms, or procedures independent of either side's will.
- reciprocal_concessions: explicit give-and-take.
- conditional_arrangement: "if X then Y" terms that handle uncertainty or contested facts.
- reversible_experiment: a time-limited trial with a review date.
- alternatives_comparison: packages designed to be better for both than their stated alternatives to agreement.

For contested facts, prefer options that do not require resolving who is right (e.g. agreed ways to verify, or arrangements that work under either account).
Each option: short title, a 1-2 sentence summary, concrete terms (who does what, when), which bases it uses, how it serves ${names.A}'s interests (serves_a), how it serves ${names.B}'s interests (serves_b), applicable objective criteria, and open questions.`,
    schema: OptionsSchema,
  });
}

function mockOptions(names) {
  return {
    options: [
      {
        title: "Trial arrangement [mock]",
        summary: "Try a compromise for four weeks, then review.",
        terms: [`${names.A} and ${names.B} try the arrangement for 4 weeks.`, "They review it together at the end."],
        bases: ["reversible_experiment"],
        serves_a: "Low-risk way to test.",
        serves_b: "Nothing is permanent.",
        objective_criteria: ["Agreed review date"],
        open_questions: ["What counts as success?"],
      },
      {
        title: "Trade across issues [mock]",
        summary: "Each gets what they value most.",
        terms: [`${names.A} gets priority on their top issue.`, `${names.B} gets priority on theirs.`],
        bases: ["different_priorities", "reciprocal_concessions"],
        serves_a: "Top priority met.",
        serves_b: "Top priority met.",
        objective_criteria: [],
        open_questions: [],
      },
    ],
  };
}

// ---------- 4. Single-text drafting ----------

const DraftSchema = z.object({
  preamble: z.string(),
  clauses: z.array(
    z.object({
      ref_id: z.string(),
      text: z.string(),
      bracketed: z.boolean(),
      bracket_note: z.string(),
    }),
  ),
  change_log: z.array(z.string()),
  improvable: z.boolean(),
});

const DRAFT_RULES = `The draft is one neutral working text, not a proposal by either side. It consists of numbered operative clauses: concrete, specific, and checkable (who, what, when, how reviewed). Include a review or exit clause where appropriate. Never include a clause that commits someone to something they have not signalled openness to without bracketing it.`;

export async function draftZero({ title, names, problemStatement, mapItems, options, a, b }) {
  if (MOCK) return mockDraft(options);
  const map = mapItems.map((i) => `- (${i.area}; ${i.status}) ${i.text}`).join("\n");
  const opts = options
    .map((o) => `### ${o.title}\n${o.summary}\nTerms:\n${o.terms.map((t) => `- ${t}`).join("\n")}\nReactions: ${names.A}: ${o.reactions.A || "none"}, ${names.B}: ${o.reactions.B || "none"}`)
    .join("\n\n");
  return call({
    system: `${PRINCIPLES}\n\n${PRIVACY_RULES}\n\n${DRAFT_RULES}`,
    prompt: `Topic: "${title}"
Joint problem definition: ${problemStatement}

Shared problem map:
${map}

Options the participants chose to build from (with their reactions):
${opts}

Shareable statements from ${names.A}:
${fmtStatements(names.A, a)}

Shareable statements from ${names.B}:
${fmtStatements(names.B, b)}

Write draft 0 of the single text. preamble: one or two neutral sentences on what this text is about. For every clause set ref_id to "" (new). Bracket (bracketed=true) any clause where you already know the participants' preferences conflict, and explain the unresolved point neutrally in bracket_note (otherwise bracket_note=""). change_log: one line "Initial draft based on: <options>". improvable=true.`,
    schema: DraftSchema,
  });
}

export async function reviseDraft({ title, names, problemStatement, version, feedback }) {
  if (MOCK) return mockRevise(version, feedback);
  const clauses = version.clauses
    .map((c) => {
      const fa = feedback.A.clauses[c.id] || { verdict: "ok" };
      const fb = feedback.B.clauses[c.id] || { verdict: "ok" };
      const fmt = (n, f) => (f.verdict === "ok" ? `${n}: OK` : `${n} MUST CHANGE: ${f.text}`);
      return `[${c.id}] (${c.status}) ${c.text}${c.bracketNote ? `\n  bracket note: ${c.bracketNote}` : ""}\n  ${fmt(names.A, fa)}\n  ${fmt(names.B, fb)}`;
    })
    .join("\n");
  return call({
    system: `${PRINCIPLES}\n\n${DRAFT_RULES}\n\nYou are the neutral keeper of the single text. You incorporate criticism from both sides into one improved draft. Both participants will see the new draft and your change log.`,
    prompt: `Topic: "${title}"
Joint problem definition: ${problemStatement}

Current draft, version ${version.n}:
Preamble: ${version.preamble}
${clauses}

General comments:
- ${names.A}: ${feedback.A.general || "(none)"}
- ${names.B}: ${feedback.B.general || "(none)"}

Produce the next version:
1. Clauses both marked OK: keep them with the same ref_id and identical text, unless a change elsewhere makes an edit strictly necessary for coherence.
2. Where only one side requested a change, or both requested compatible changes, incorporate them as far as the other side's stated interests allow. Look for wording that meets both.
3. Where requested changes conflict, write the best neutral bridging wording you can and set bracketed=true with a bracket_note that states the unresolved question neutrally. Never silently pick a side.
4. New clauses (e.g. from general comments) get ref_id "". Clauses that should be dropped are simply omitted; mention it in change_log.
5. change_log: short entries explaining each change and whose concern it addresses, without quoting anyone's criticism verbatim.
6. improvable: false if you believe no further wording change can bridge the remaining brackets (the remaining disagreement is about preferences, not wording).`,
    schema: DraftSchema,
  });
}

function mockDraft(options) {
  const terms = options.flatMap((o) => o.terms);
  return {
    preamble: "Working draft [mock].",
    clauses: terms.map((t) => ({ ref_id: "", text: t, bracketed: false, bracket_note: "" })),
    change_log: [`Initial draft based on: ${options.map((o) => o.title).join(", ")}`],
    improvable: true,
  };
}

function mockRevise(version, feedback) {
  const log = [];
  const clauses = version.clauses.map((c) => {
    const changes = ["A", "B"].map((p) => feedback[p].clauses[c.id]).filter((f) => f?.verdict === "change");
    if (!changes.length) return { ref_id: c.id, text: c.text, bracketed: false, bracket_note: "" };
    if (changes.length === 1) {
      log.push(`${c.id}: reworded per request.`);
      return { ref_id: c.id, text: changes[0].text, bracketed: false, bracket_note: "" };
    }
    log.push(`${c.id}: conflicting requests, bracketed.`);
    return { ref_id: c.id, text: c.text, bracketed: true, bracket_note: "Both requested different changes. [mock]" };
  });
  return { preamble: version.preamble, clauses, change_log: log.length ? log : ["No changes."], improvable: log.length > 0 };
}

// ---------- 5. Private alternative (BATNA) check ----------

const BatnaSchema = z.object({
  verdict: z.enum(["draft_looks_better", "alternative_looks_better", "unclear"]),
  assessment: z.string(),
  questions_to_consider: z.array(z.string()),
});

export async function batnaCheck({ title, name, own, version }) {
  if (MOCK) return { verdict: "unclear", assessment: "[mock] Compare carefully.", questions_to_consider: ["How likely is your alternative to work?"] };
  const draft = version.clauses.map((c, i) => `${i + 1}. ${c.status === "bracketed" ? "[UNRESOLVED] " : ""}${c.text}`).join("\n");
  return call({
    system: `${PRINCIPLES}\n\nYou are helping ONE participant privately. The other participant never sees this. You are not a lawyer or financial advisor; do not give legal or financial advice. Do not push them toward agreement or away from it.`,
    prompt: `Topic: "${title}"
Participant: ${name}

${name}'s own confirmed statements (including private ones):
${own.map((s) => `- (${s.category}) ${s.text}`).join("\n")}

Current shared draft:
${draft}

Help ${name} compare the current draft with their own best alternative if no agreement is reached (from their statements). Consider their interests, concerns and constraints, and how realistic the alternative is. verdict: which looks better for them on the information available, or unclear. assessment: 3-6 sentences, honest and balanced, addressed to ${name} as "you". questions_to_consider: up to 4 questions they should answer for themselves before accepting or rejecting.`,
    schema: BatnaSchema,
    effort: "medium",
  });
}
