import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDrill, assessDrillWithAI, gradeInterview } from "../src/assessment.ts";
import { getPrivateDrill, getPrivateInterview, getPublicChallenge, listChallenges } from "../src/challenges.ts";

test("catalog has thirteen drills and six JavaScript interview tasks", () => {
  assert.equal(listChallenges("drill").length, 13);
  assert.equal(listChallenges("interview").length, 6);
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
    assert.ok(getPublicChallenge(privateDrill.id)?.rubric.every((criterion:any)=>!("signals" in criterion)));
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

test("every interview reference solution passes its fixed test environment", async () => {
  const { runCode } = await import('../src/runner.ts');
  for (const publicInterview of listChallenges('interview')) {
    const interview = getPrivateInterview(publicInterview.id)!;
    const results = await runCode(interview.referenceSolution, interview.tests);
    assert.equal(results.filter(({passed})=>passed).length, interview.tests.length, interview.id);
  }
});

test("drill fallback caps keyword lists and repeated answers", () => {
  const drill = getPrivateDrill("frame-expense-tracker")!;
  const result = assessDrill(drill.id, drill.strongExample)!;
  assert.equal(result.ratingEligible, false);
  assert.equal(result.method, "structured-rubric-fallback");
  assert.equal(result.maxScore, 100);
  assert.equal(assessDrill("missing", "text"), undefined);
  const empty = assessDrill(drill.id, "")!;
  assert.equal(empty.score, 0);
  const salad = assessDrill(drill.id, "student category localStorage no backend negative 12 plan first")!;
  assert.ok(salad.score <= 20);
  assert.match(salad.overallFeedback, /too brief/i);
  const repeated = assessDrill(drill.id, drill.strongExample, {reusedAnswer:true})!;
  assert.ok(repeated.score <= 20);
  assert.match(repeated.qualityFlags.join(' '), /repeats a previously submitted response/i);
});

test("semantic drill assessment returns grounded, criterion-specific coaching", async () => {
  const drill = getPrivateDrill("frame-expense-tracker")!;
  const evaluator = async () => ({provider:'test-model',text:JSON.stringify({criteria:drill.rubric.map((criterion,index)=>({id:criterion.id,status:index===0?'partial':'missing',score:index===0?12:0,evidence:index===0?'Names a student trip but omits the workflow.':'No evidence.',feedback:index===0?'Connect the student action to the category total.':`Add ${criterion.label.toLowerCase()} with a concrete expected outcome.`})),strengths:['Identifies the student scenario.'],improvements:['Add an input/output example.'],overallFeedback:'The response identifies the setting but does not yet give an executable, verifiable instruction.'})});
  const result = await assessDrillWithAI(drill.id,'A student needs a trip tracker. Ask a few questions before making anything, then build it.',{evaluator}) as any;
  assert.equal(result.method,'semantic-rubric-review');
  assert.equal(result.provider,'test-model');
  assert.match(result.criteria[0].feedback,/category total/i);
  assert.match(result.overallFeedback,/executable/i);
  assert.ok(result.improvements.length>0);
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
