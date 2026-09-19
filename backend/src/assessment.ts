import { getPrivateDrill, getPrivateInterview } from "./challenges.ts";

export interface DrillCriterionResult {
  id: string;
  label: string;
  pointsEarned: number;
  pointsPossible: number;
  /** Counts lexical evidence groups matched; this is not a semantic judgment. */
  evidenceGroupsMatched: number;
  evidenceGroupsTotal: number;
  feedback: string;
}

export interface DrillAssessment {
  challengeId: string;
  score: number;
  maxScore: number;
  criteria: DrillCriterionResult[];
  ratingEligible: false;
  method: "transparent-phrase-check";
  notice: string;
}

const DRILL_NOTICE = "This score only checks for selected words and phrases from the rubric. It cannot determine whether your response is correct, safe, or well reasoned. Treat it as a checklist, not an AI skill rating.";

/**
 * Checklist-style feedback for authored drills. Phrase matching is deliberately
 * reported as evidence presence only; it does not establish that an idea is
 * understood or correctly applied.
 */
export function assessDrill(challengeId: string, response: string): DrillAssessment | undefined {
  const drill = getPrivateDrill(challengeId);
  if (!drill) return undefined;
  const text = typeof response === "string" ? response : "";
  const criteria = drill.rubric.map((criterion) => {
    const matches = criterion.signals.map((group) =>
      group.some((pattern) => {
        try { return new RegExp(pattern, "i").test(text); }
        catch { return false; }
      }),
    );
    const evidenceGroupsMatched = matches.filter(Boolean).length;
    const pointsEarned = Math.round(criterion.points * evidenceGroupsMatched / Math.max(matches.length, 1));
    return {
      id: criterion.id,
      label: criterion.label,
      pointsEarned,
      pointsPossible: criterion.points,
      evidenceGroupsMatched,
      evidenceGroupsTotal: matches.length,
      feedback: evidenceGroupsMatched === matches.length
        ? "Phrase checks found evidence for each item. Review whether the response applies each point correctly."
        : `${criterion.suggestion} Phrase checks found ${evidenceGroupsMatched} of ${matches.length} evidence groups; this does not assess meaning.`,
    };
  });
  return {
    challengeId,
    score: criteria.reduce((sum, item) => sum + item.pointsEarned, 0),
    maxScore: criteria.reduce((sum, item) => sum + item.pointsPossible, 0),
    criteria,
    ratingEligible: false,
    method: "transparent-phrase-check",
    notice: DRILL_NOTICE,
  };
}

/** Results emitted by the trusted, isolated code runner after it executes fixed tests. */
export interface TrustedTestResult {
  testId: string;
  passed: boolean;
}

export interface InterviewGrade {
  challengeId: string;
  score: number;
  maxScore: number;
  passed: number;
  total: number;
  complete: boolean;
  ratingEligible: boolean;
  visibleTests: { id: string; label: string; passed: boolean }[];
  hiddenTestsPassed: number;
  hiddenTestsTotal: number;
  notice: string;
}

/**
 * Grades only fixed test outcomes from the trusted runner. Requires one result
 * for every expected ID and rejects unknown, duplicate, or malformed results.
 * Hidden inputs and expected outputs are never included in the returned grade.
 */
export function gradeInterview(challengeId: string, results: TrustedTestResult[]): InterviewGrade | undefined {
  const interview = getPrivateInterview(challengeId);
  if (!interview) return undefined;
  const expected = interview.tests;
  const expectedIds = new Set(expected.map((test) => test.id));
  const validShape = Array.isArray(results)
    && results.every((result) => result && typeof result.testId === "string" && typeof result.passed === "boolean");
  const uniqueIds = new Set(validShape ? results.map((result) => result.testId) : []);
  const complete = validShape
    && results.length === expected.length
    && uniqueIds.size === expected.length
    && results.every((result) => expectedIds.has(result.testId));
  const resultById = new Map(validShape ? results.map((result) => [result.testId, result.passed]) : []);
  const passed = expected.filter((test) => resultById.get(test.id) === true).length;
  const visibleTests = expected.filter((test) => !test.hidden).map((test) => ({
    id: test.id,
    label: test.label,
    passed: resultById.get(test.id) === true,
  }));
  const hidden = expected.filter((test) => test.hidden);
  const hiddenTestsPassed = hidden.filter((test) => resultById.get(test.id) === true).length;
  return {
    challengeId,
    score: complete ? passed : 0,
    maxScore: expected.length,
    passed: complete ? passed : 0,
    total: expected.length,
    complete,
    ratingEligible: complete,
    visibleTests,
    hiddenTestsPassed: complete ? hiddenTestsPassed : 0,
    hiddenTestsTotal: hidden.length,
    notice: complete
      ? "Score is the fraction of fixed runner tests passed. Hidden test details are withheld."
      : "No score was recorded because the runner result set was incomplete or contained duplicate, unknown, or malformed test IDs.",
  };
}
