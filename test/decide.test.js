import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, interpret, parseInput, importanceOf, MODEL, LIMITS } from "../relay/decide.js";

const answers = (crisis, yesNo, yes, score = 3) => ({
  model: MODEL,
  answers: {
    crisis: { type: "noul", noul: crisis },
    is_yes_no: { type: "noul", noul: yesNo },
    decide: { type: "noul", noul: yes },
    importance: { type: "score", score, confidence: 1 },
  },
  usage: { input_tokens: 755, output_tokens: 20 },
});

test("parseInput trims, collapses spaces and rejects bad input", () => {
  assert.deepEqual(parseInput({ question: "  Should   I  move? ", details: " far\naway " }), { question: "Should I move?", details: "far away" });
  assert.equal(parseInput({ question: "Should I move?" }).details, "");
  assert.ok(parseInput(null).error);
  assert.ok(parseInput([]).error);
  assert.ok(parseInput({ question: 42 }).error);
  assert.ok(parseInput({ question: "ok", details: 5 }).error);
  assert.ok(parseInput({ question: " a " }).error);
  assert.ok(parseInput({ question: "x".repeat(LIMITS.question + 1) }).error);
  assert.ok(parseInput({ question: "Should I?", details: "x".repeat(LIMITS.details + 1) }).error);
});

test("buildRequest asks four questions over one state and pins the model", () => {
  const body = buildRequest({ question: "Should I quit my job?", details: "" });
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.state, { question: "Should I quit my job?" });
  assert.deepEqual(Object.keys(body.questions).sort(), ["crisis", "decide", "importance", "is_yes_no"]);
  assert.equal(body.questions.importance.criteria.length, 4);
  const withDetails = buildRequest({ question: "Should I quit my job?", details: "My boss yells." });
  assert.equal(withDetails.state.details, "My boss yells.");
  assert.match(withDetails.questions.decide.instructions, /`details`/);
  assert.doesNotMatch(body.questions.decide.instructions, /`details`/);
});

test("interpret turns probabilities into a verdict", () => {
  assert.equal(interpret(answers(0.02, 0.98, 0.83)).verdict, "yes");
  assert.equal(interpret(answers(0.02, 0.98, 0.27)).verdict, "no");
  assert.equal(interpret(answers(0.02, 0.98, 0.5)).verdict, "yes");
  assert.equal(interpret(answers(0.01, 0.03, 0.51)).verdict, "not-yes-no");
  assert.equal(interpret(answers(0.99, 0.95, 0.04)).verdict, "crisis");
  assert.equal(interpret(answers(0.99, 0.01, 0.5)).verdict, "crisis", "a crisis wins over a malformed question");
  assert.equal(interpret(answers(0.02, 0.98, 0.53)).torn, true);
  assert.equal(interpret(answers(0.02, 0.98, 0.83)).torn, false);
  assert.throws(() => interpret({ answers: {} }), /did not answer/);
});

test("importanceOf rounds the probability-weighted level", () => {
  assert.equal(importanceOf({ score: 3 }).key, "major");
  assert.equal(importanceOf({ score: 2.46 }).key, "notable");
  assert.equal(importanceOf({ score: 1.56 }).key, "notable");
  assert.equal(importanceOf({ score: 0.4 }).key, "trivial");
  assert.equal(importanceOf({ score: 0 }).level, 1);
  assert.equal(importanceOf({ score: 9 }).key, "major");
  assert.equal(importanceOf({}), null);
});
