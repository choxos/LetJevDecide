/**
 * What Jev is asked, and how its answers become a verdict. Pure code with no I/O, shared by the
 * relay and the tests.
 *
 * Jev (TypeSafe's System One model) does not write text. It answers typed questions about a
 * `state` with probabilities. One request carries four questions over the same state, so they run
 * in parallel and cost one round trip:
 *
 *   crisis     Noul   does the question hint at danger (then nobody decides it)
 *   is_yes_no  Noul   is it a yes or no decision at all
 *   decide     Noul   should the asker do it: the probability of yes is Jev's verdict
 *   importance Score  how big the decision is, on the scale of Levitt's (2016) coin toss study
 */

export const MODEL = "jev-1.13.0"; // pinned: aliases move on release, and the thresholds below were checked on this version
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export const LIMITS = { question: 200, details: 1000 };

export const T = {
  crisis: 0.5, // at or above: show help lines instead of a verdict
  yesNo: 0.3, // below: ask for a yes or no question instead of deciding
  torn: 0.1, // within this of 0.5, Jev is on the fence and says so
};

export const IMPORTANCE = [
  { key: "trivial", label: "Trivial", text: "Trivial: an everyday choice forgotten within days, such as what to eat, watch or wear tonight" },
  { key: "minor", label: "Minor", text: "Minor: a choice with short, limited effects, such as a purchase, a haircut, a party or a weekend plan" },
  {
    key: "notable",
    label: "Notable",
    text: "Notable: a choice that shapes habits, money or plans for months, such as a diet, joining a gym, a tattoo, asking for a raise or trying online dating",
  },
  {
    key: "major",
    label: "Major",
    text: "Major: a life-changing decision, such as quitting a job, ending a relationship, moving, going back to school, having a child or starting a business",
  },
];

const clean = (s, max) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** The request body's own checks: a question of 3 to 200 characters, optional details. */
export function parseInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send a JSON object with a question." };
  if (typeof body.question !== "string") return { error: "The question must be text." };
  if (body.details != null && typeof body.details !== "string") return { error: "The details must be text." };
  if (body.question.trim().length > LIMITS.question) return { error: `Keep the question under ${LIMITS.question} characters.` };
  if ((body.details || "").trim().length > LIMITS.details) return { error: `Keep the details under ${LIMITS.details} characters.` };
  const question = clean(body.question, LIMITS.question);
  if (question.length < 3) return { error: "Type a question first." };
  return { question, details: clean(body.details, LIMITS.details) };
}

/** The TypeSafe request for one question. Question ids are never sent to the model. */
export function buildRequest({ question, details }) {
  const state = { question };
  if (details) state.details = details;
  const about = details ? "`question` (with what the asker adds in `details`)" : "`question`";
  return {
    model: MODEL,
    state,
    questions: {
      crisis: {
        type: "noul",
        instructions: `Does ${about} suggest a crisis that a coin or a computer must not decide: suicide or self-harm, hurting another person, abuse or violence against the asker, or a medical emergency?`,
        criteria: {
          true: "It mentions or hints at suicide, self-harm, wanting to hurt someone, abuse, being in danger, or an urgent medical situation",
          false: "An ordinary decision with no sign of danger to the asker or anyone else",
        },
      },
      is_yes_no: {
        type: "noul",
        instructions: "Is `question` a decision its asker could settle with a plain yes or no, about whether to do one thing?",
        criteria: {
          true: "A yes or no decision about one action, plan or change, such as: Should I quit my job? Should I get a dog? Do I text him back?",
          false:
            "Not a yes or no decision: a choice among named options (A or B), an open question (what, where, how, when, which, why), a question of fact or trivia, a greeting, or gibberish",
        },
      },
      decide: {
        type: "noul",
        instructions: `Should the person who asked ${about} do it? Weigh what they say, if anything, and ordinary common sense about what tends to leave people better off.`,
        criteria: {
          true: "Yes: doing it is more likely than not to leave the asker better off than not doing it",
          false: "No: not doing it, or keeping things as they are, is the better choice for the asker",
        },
      },
      importance: {
        type: "score",
        instructions: "How much could the decision in `question` change the asker's life?",
        criteria: IMPORTANCE.map((level) => level.text),
      },
    },
  };
}

const prob = (answer, field) => {
  const v = Number(answer?.[field]);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

/** The level a Score answer lands on: its `score` is the probability-weighted 0-based level. */
export function importanceOf(answer) {
  const v = Number(answer?.score);
  if (!Number.isFinite(v)) return null;
  const n = IMPORTANCE.length;
  const k = Math.min(n - 1, Math.max(0, Math.round(v)));
  return { key: IMPORTANCE[k].key, label: IMPORTANCE[k].label, level: k + 1, of: n };
}

/** Jev's answers, read by the policy above. `verdict` is yes, no, not-yes-no or crisis. */
export function interpret(response) {
  const a = response?.answers || {};
  const crisis = prob(a.crisis, "noul");
  const yesNo = prob(a.is_yes_no, "noul");
  const yes = prob(a.decide, "noul");
  if (yes == null) throw new Error("Jev did not answer the question");
  const importance = importanceOf(a.importance);
  let verdict = yes >= 0.5 ? "yes" : "no";
  if (yesNo != null && yesNo < T.yesNo) verdict = "not-yes-no";
  if (crisis != null && crisis >= T.crisis) verdict = "crisis";
  return {
    verdict,
    yes,
    torn: Math.abs(yes - 0.5) < T.torn,
    importance,
    model: response.model || MODEL,
    signals: { crisis, yesNo },
  };
}
