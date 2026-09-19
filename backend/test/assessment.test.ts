import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDrill, gradeInterview } from "../src/assessment.ts";
import { getPrivateDrill, getPrivateInterview, getPublicChallenge, listChallenges } from "../src/challenges.ts";

test("catalog has twelve drills and three JavaScript interview tasks", () => {
  assert.equal(listChallenges("drill").length, 12);
  assert.equal(listChallenges("interview").length, 3);
  for (const challenge of listChallenges("interview")) {
    assert.equal(challenge.functionName, "solve");
    assert.ok(challenge.starterCode?.includes("function solve"));
  }
});

test("public challenge projections do not expose judge examples, solutions, or tests", () => {
  for (const privateDrill of listChallenges("drill").map(({ id }) => getPrivateDrill(id)!)) {
    const json = JSON.stringify(getPublicChallenge(privateDrill.id));
    assert.ok(!json.includes(privateDrill.strongExample));
    assert.ok(!json.includes(privateDrill.weakExample));
    assert.ok(!json.includes("signals"));
  }
  for (const privateInterview of listChallenges("interview").map(({ id }) => getPrivateInterview(id)!)) {
    const json = JSON.stringify(getPublicChallenge(privateInterview.id));
    assert.ok(!json.includes(privateInterview.referenceSolution));
    assert.ok(!json.includes("hidden"));
    for (const hidden of privateInterview.tests.filter(({ hidden }) => hidden)) {
      assert.ok(!json.includes(hidden.id));
      assert.ok(!json.includes(JSON.stringify(hidden)));
    }
  }
});

test("drill assessment is explicit about phrase matching and never rating eligible", () => {
  const drill = getPrivateDrill("frame-expense-tracker")!;
  const result = assessDrill(drill.id, drill.strongExample)!;
  assert.equal(result.ratingEligible, false);
  assert.equal(result.method, "transparent-phrase-check");
  assert.match(result.notice, /cannot determine whether your response is correct/i);
  assert.equal(result.maxScore, 100);
  assert.equal(assessDrill("missing", "text"), undefined);
  const empty = assessDrill(drill.id, "")!;
  assert.equal(empty.score, 0);
  assert.ok(empty.criteria.every((criterion) => criterion.feedback.includes("Phrase checks found")));
});

test("interview grade accepts complete unique trusted runner results and hides hidden cases", () => {
  const interview = getPrivateInterview("interview-retry-planner")!;
  const results = interview.tests.map(({ id }, index) => ({ testId: id, passed: index % 2 === 0 }));
  const grade = gradeInterview(interview.id, results)!;
  assert.equal(grade.complete, true);
  assert.equal(grade.ratingEligible, true);
  assert.equal(grade.total, interview.tests.length);
  assert.equal(grade.passed, results.filter(({ passed }) => passed).length);
  assert.equal(grade.visibleTests.length, interview.tests.filter(({ hidden }) => !hidden).length);
  assert.equal(grade.hiddenTestsPassed, interview.tests.filter(({ hidden }, i) => hidden && results[i].passed).length);
  const json = JSON.stringify(grade);
  for (const hidden of interview.tests.filter(({ hidden }) => hidden)) {
    assert.ok(!json.includes(hidden.id));
    assert.ok(!json.includes(JSON.stringify(hidden)));
  }
});

test("incomplete, duplicated, and unknown interview result IDs cannot earn a score", () => {
  const interview = getPrivateInterview("interview-retry-planner")!;
  const ids = interview.tests.map(({ id }) => id);
  const incomplete = gradeInterview(interview.id, ids.slice(1).map((testId) => ({ testId, passed: true })))!;
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.ratingEligible, false);
  assert.equal(incomplete.score, 0);
  const duplicate = gradeInterview(interview.id, [...ids.slice(1).map((testId) => ({ testId, passed: true })), { testId: ids[1], passed: true }])!;
  assert.equal(duplicate.complete, false);
  const unknown = gradeInterview(interview.id, [...ids.slice(1).map((testId) => ({ testId, passed: true })), { testId: "invented", passed: true }])!;
  assert.equal(unknown.complete, false);
  assert.equal(gradeInterview("missing", []), undefined);
});
