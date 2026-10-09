// ---------------------------------------------------------------------------
// Phase 6 — DETERMINISTIC server-side assessment scoring (pure logic).
//
// This module is deliberately PURE: no Prisma, no HTTP, no clock, no AI. The
// submit transaction (jobAssessmentAttempt.repository#submitAndScoreTransactional)
// feeds it the PERSISTED questions and the PERSISTED answers; it returns the
// earned score, the maximum score and the percentage. Nothing a browser sends
// can reach it — a candidate submission only arrives here as an `answers` row
// that the attempt service already validated against the persisted question
// type/options before it was ever written.
//
// Correctness source of truth: JobAssessmentQuestion.correctAnswer — the
// trusted server-side key written at generation time and validated (FastAPI
// contract + backend worker gate) against the question's own options.
// Questions without a key — every text-shaped type, and any legacy row
// predating Phase 6 — are UNGRADED: they contribute their points to maxScore
// and earn 0 until a future manual-grading phase exists.
//
// Rules (exact, deterministic, no partial credit, no fuzz, no AI):
//   * SINGLE_CHOICE:   persisted {choice}  equals key {choice}        → full points
//   * MULTIPLE_CHOICE: persisted {choices} set-equals key {choices}   → full points
//   * any other type / no key / no answer                            → 0 points
//   * percentage = (score / maxScore) * 100, 2 decimals;
//     maxScore = 0 (no questions) → percentage = 0 (never divide by zero)
// ---------------------------------------------------------------------------

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTIPLE_CHOICE"]);

const round2 = (value) => Number(value.toFixed(2));

const gradeQuestion = (question, answerRow) => {
  const points = Number.isInteger(question.points) && question.points > 0 ? question.points : 0;
  const key = question.correctAnswer;

  // No deterministic key → ungraded: never earned, never marked wrong.
  if (!CHOICE_TYPES.has(question.questionType) || !key || typeof key !== "object") {
    return { questionId: question.id, pointsAvailable: points, pointsEarned: 0, correct: null };
  }

  const submitted =
    answerRow && answerRow.answer && typeof answerRow.answer === "object" ? answerRow.answer : null;

  if (question.questionType === "SINGLE_CHOICE") {
    const expected = typeof key.choice === "string" ? key.choice : null;
    const actual = submitted && typeof submitted.choice === "string" ? submitted.choice : null;
    const correct = expected !== null && actual === expected;
    return {
      questionId: question.id,
      pointsAvailable: points,
      pointsEarned: correct ? points : 0,
      correct,
    };
  }

  // MULTIPLE_CHOICE — exact set equality, no partial credit. The saved answer
  // was normalized to a duplicate-free list by the attempt service, so equal
  // length plus full membership is decisive.
  const expected = Array.isArray(key.choices)
    ? key.choices.filter((choice) => typeof choice === "string")
    : [];
  const actual =
    submitted && Array.isArray(submitted.choices)
      ? submitted.choices.filter((choice) => typeof choice === "string")
      : [];
  const correct =
    expected.length > 0 &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((choice) => actual.includes(choice));
  return {
    questionId: question.id,
    pointsAvailable: points,
    pointsEarned: correct ? points : 0,
    correct,
  };
};

// questions: persisted JobAssessmentQuestion rows (id/questionType/points/
// correctAnswer). answers: persisted JobAssessmentAttemptAnswer rows
// (questionId/answer). Both come from the SAME transaction that will persist
// the result, so the score can never be computed from anything else.
const scoreAttempt = ({ questions = [], answers = [] }) => {
  const answerByQuestion = new Map();
  for (const row of answers) {
    if (row && row.questionId) answerByQuestion.set(row.questionId, row);
  }

  const details = questions.map((question) =>
    gradeQuestion(question, answerByQuestion.get(question.id))
  );
  const score = details.reduce((sum, detail) => sum + detail.pointsEarned, 0);
  const maxScore = questions.reduce(
    (sum, question) =>
      sum + (Number.isInteger(question.points) && question.points > 0 ? question.points : 0),
    0
  );
  const scorePercentage = maxScore > 0 ? round2((score / maxScore) * 100) : 0;

  return { score, maxScore, scorePercentage, details };
};

module.exports = { scoreAttempt, gradeQuestion };