import test from "node:test";
import assert from "node:assert/strict";
import { asksForJudgment, looksLikeComparison } from "./route.js";

test("comparison-style questions are recognised", () => {
  for (const question of [
    "compare seltos with duster",
    "Seltos vs Duster",
    "seltos versus duster boot space",
    "what is the difference between HTX and GTX?",
    "is seltos better or duster in 18lakh bracket",
    "which one has more boot space?",
    "pros and cons of the diesel",
  ])
    assert.equal(looksLikeComparison(question), true, question);
});

test("single-topic lookups are not", () => {
  for (const question of [
    "How much boot space does the Duster have?",
    "does seltos has sunroof?",
    "how many variants does seltos have?",
    "What engine options does the Seltos have?",
    "Where is the warranty explained?",
    "",
  ])
    assert.equal(looksLikeComparison(question), false, question);
  assert.equal(looksLikeComparison(undefined), false);
});

test("price, value and recommendation questions are judgment questions", () => {
  for (const question of [
    "which mid variant is more value for money between seltos and duster?",
    "is seltos better or duster in 18lakh bracket",
    "how much does the seltos cost",
    "should I buy the seltos",
  ])
    assert.equal(asksForJudgment(question), true, question);
});

test("lookups are not judgment questions", () => {
  for (const question of ["how many variants does seltos have", "what is the boot space of the duster", "which trims have the 7DCT turbo petrol"])
    assert.equal(asksForJudgment(question), false, question);
});
