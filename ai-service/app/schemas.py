from typing import Annotated, Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Text = Annotated[str, Field(strict=True, min_length=1, max_length=4000)]
Name = Annotated[str, Field(strict=True, min_length=1, max_length=200)]
Weight = Annotated[int, Field(strict=True, ge=0, le=100)]

# The four areas an analysis covers. This Literal is the contract's single
# definition of them; the backend's JobAnalysisSection enum mirrors it 1:1. A
# clarification question and an assessment question are attributed to the same
# area, so the assessment can be checked against what the recruiter clarified.
Section = Literal["JOB_OVERVIEW", "RESPONSIBILITIES", "REQUIRED_SKILLS", "TOOLS_SOFTWARE"]

# ---------------------------------------------------------------------------
# Structured job requirements.
#
# The recruiter's job data is normalized into a single flat list of
# requirements, each tagged with a category, a description, a priority and the
# analysis Section it belongs to. JOB_ANALYSIS produces this list (WITHOUT any
# key — the model is never allowed to mint requirement identities). The BACKEND
# assigns the deterministic REQ_1, REQ_2, … keys when it persists the analysis,
# and every later operation (ASSESSMENT_GENERATION, CANDIDATE_ANALYSIS) is fed
# the SAME frozen, keyed requirements so an assessment question and a candidate
# evaluation can each cite the exact requirement they address.
#
# Assessable categories (SKILL, TOOL, RESPONSIBILITY, EXPERIENCE, EDUCATION) are
# the ones an assessment may legitimately probe. EMPLOYMENT_TYPE, WORK_MODE and
# LOCATION are contextual facts of the role, never something a candidate is
# tested on, so they are carried for completeness but never required to be
# covered by an assessment question.
# ---------------------------------------------------------------------------
RequirementCategory = Literal[
    "SKILL",
    "TOOL",
    "RESPONSIBILITY",
    "EXPERIENCE",
    "EDUCATION",
    "EMPLOYMENT_TYPE",
    "WORK_MODE",
    "LOCATION",
]
RequirementPriority = Literal["MUST_HAVE", "NICE_TO_HAVE"]

# The categories an assessment question is allowed to verify. Employment type,
# work mode and location are role context, not assessable candidate criteria.
ASSESSABLE_REQUIREMENT_CATEGORIES = frozenset(
    {"SKILL", "TOOL", "RESPONSIBILITY", "EXPERIENCE", "EDUCATION"}
)

# The backend-assigned requirement key. NEVER produced by the model: the AI
# returns requirements without keys and the deterministic key is stamped on by
# the backend at persistence time. It is validated here only on the operations
# that RECEIVE already-keyed requirements (assessment/candidate generation).
RequirementKey = Annotated[
    str, Field(strict=True, min_length=1, max_length=50, pattern=r"^REQ_[0-9]+$")
]

# Question shapes an assessment may use — deliberately a subset of the backend's
# AssessmentQuestionType enum: only the shapes an AI can generate and score from
# text alone.
QuestionType = Literal["SINGLE_CHOICE", "MULTIPLE_CHOICE", "SCENARIO", "PROBLEM_SOLVING", "SHORT_ANSWER"]
Difficulty = Literal["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]

class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")

class Skill(Contract):
    name: Name
    weight: Weight

# One normalized job requirement. Produced by JOB_ANALYSIS (without a key) and
# consumed — already keyed by the backend — by assessment/candidate generation.
# Every field is a strict, enumerated value so the three contracts cannot drift.
class Requirement(Contract):
    category: RequirementCategory
    description: Text
    priority: RequirementPriority
    section: Section

# A requirement carrying the backend-assigned deterministic key. Used ONLY on the
# operations that receive the frozen, keyed requirement set. The model never
# invents a key: an unknown or malformed key fails validation before the provider
# is called, so an assessment question can only ever cite a real requirement.
class KeyedRequirement(Requirement):
    requirementKey: RequirementKey

class JobInput(Contract):
    title: Name
    yearsExperience: Annotated[int, Field(strict=True, ge=0, le=100)] | None
    description: Annotated[str, Field(strict=True, min_length=1, max_length=30000)]
    skills: list[Skill] = Field(max_length=100)
    tools: list[Name] = Field(max_length=100)
    questions: list[Text] = Field(max_length=100)
    # Phase 4 — structured job fields. All optional so legacy snapshots (jobs
    # created before these existed) still validate: an absent field is simply a
    # job that did not express it. The values are free-form enums/strings the
    # recruiter chose; the AI only reads them, it never has to invent them.
    employmentType: Name | None = None
    workMode: Name | None = None
    location: Name | None = None
    responsibilities: list[Text] = Field(default_factory=list, max_length=50)
    educationRequirements: list[Text] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def unique_names(self):
        names = [s.name for s in self.skills]
        if len(names) != len(set(names)) or len(self.tools) != len(set(self.tools)):
            raise ValueError("Duplicate names")
        return self


class AnalysisRequest(Contract):
    schemaVersion: Literal["1"]
    aiJobId: Name
    operation: Literal["JOB_ANALYSIS"]
    request: JobInput

class SkillAnalysis(Skill):
    expectation: Text
    source: Literal["EXPLICIT", "INFERRED", "UNCLEAR"]

class ToolAnalysis(Contract):
    name: Name
    expectation: Text

class ClarificationQuestion(Contract):
    """One AI clarification question, attributed to the analysis area it concerns.

    The section is NOT derived by the caller: the model that identifies an
    ambiguity is the only thing that knows which requirement it belongs to, so
    attribution is part of the contract. This is what lets the recruiter UI show
    per-section question counts without guessing at them.
    """
    section: Section
    question: Text

class Analysis(Contract):
    summary: Text
    responsibilities: list[Text] = Field(max_length=50)
    skillAnalysis: list[SkillAnalysis] = Field(max_length=100)
    toolAnalysis: list[ToolAnalysis] = Field(max_length=100)
    # Phase 4 — the normalized, flat requirement list. The model carries NO key
    # here: the backend stamps the deterministic REQ_n keys when it persists the
    # analysis. Optional (default empty) so a legacy-shaped response that omits
    # it still validates; an explicitly structured job will always populate it.
    requirements: list[Requirement] = Field(default_factory=list, max_length=200)
    ambiguities: list[Text] = Field(max_length=50)
    clarificationQuestions: list[ClarificationQuestion] = Field(max_length=50)
    warnings: list[Text] = Field(max_length=50)

    def validate_input(self, job: JobInput):
        skills = [(s.name, s.weight) for s in self.skillAnalysis]
        expected = [(s.name, s.weight) for s in job.skills]
        tools = [t.name for t in self.toolAnalysis]
        if sorted(skills) != sorted(expected) or sorted(tools) != sorted(job.tools):
            raise ValueError("Analysis must preserve supplied skills, weights and tools")
        if len({s.name for s in self.skillAnalysis}) != len(skills):
            raise ValueError("Duplicate analysis skill")
        # A normalized requirement must never duplicate an identical requirement:
        # two MUST_HAVE SKILL requirements with the same description would let the
        # backend mint two keys for the same ask and double-count coverage.
        seen = {(r.category, r.description.strip().lower()) for r in self.requirements}
        if len(seen) != len(self.requirements):
            raise ValueError("Duplicate normalized requirement")
        return self

class AnalysisResponse(Contract):
    schemaVersion: Literal["1"] = "1"
    aiJobId: Name
    operation: Literal["JOB_ANALYSIS"] = "JOB_ANALYSIS"
    provider: Literal["gemini"] = "gemini"
    model: Name
    analysis: Analysis


# ---------------------------------------------------------------------------
# Assessment generation (the second AI operation).
#
# After the recruiter approves the clarification questions, the same durable
# pipeline runs this operation. The input is the job PLUS those approved
# questions, so the assessment is generated from what the recruiter confirmed
# rather than from a second, independent reading of the job.
# ---------------------------------------------------------------------------

# Hard platform limits for the assessment stage. Mirrored 1:1 by the backend's
# job.validation.js and the frontend's jobForm constants — the backend and this
# contract are the two authoritative enforcers; no caller and no AI output may
# exceed them. The requested count/duration are RECRUITER settings frozen into
# the request; the AI response carries neither — duration in particular is
# never an AI decision.
MAX_ASSESSMENT_QUESTIONS = 45
MIN_ASSESSMENT_DURATION_SECONDS = 60
MAX_ASSESSMENT_DURATION_SECONDS = 5400  # 90 minutes

class ClarificationInput(Contract):
    section: Section
    question: Text

class AssessmentInput(Contract):
    job: JobInput
    clarifications: list[ClarificationInput] = Field(max_length=50)
    # Phase 4 — the FROZEN, backend-keyed requirement set produced by
    # JOB_ANALYSIS. This is NOT re-derived from the live job: the assessment must
    # be generated against the exact requirements the analysis committed, so a
    # later edit to the job can never change what an assessment is tested on.
    # Optional (default empty) so legacy snapshots without requirements still
    # validate. Every generated question may cite one of these keys.
    requirements: list[KeyedRequirement] = Field(default_factory=list, max_length=200)
    # Recruiter's configured assessment shape, frozen into the request snapshot.
    # Optional (None = legacy jobs saved before the setting existed). When
    # present, the generated assessment MUST contain exactly this many
    # questions — every mandatory recruiter question plus AI additions.
    requestedQuestionCount: (
        Annotated[int, Field(strict=True, ge=1, le=MAX_ASSESSMENT_QUESTIONS)] | None
    ) = None
    # The candidate timer in whole seconds. NEVER an AI output: it is validated
    # here only so a misconfigured snapshot fails fast at the boundary.
    requestedDurationSeconds: (
        Annotated[
            int,
            Field(
                strict=True,
                ge=MIN_ASSESSMENT_DURATION_SECONDS,
                le=MAX_ASSESSMENT_DURATION_SECONDS,
            ),
        ]
        | None
    ) = None

    @model_validator(mode="after")
    def settings_are_satisfiable(self):
        """Deterministic configuration gate.

        Recruiter questions are preserved verbatim, so a requested count below
        the number of mandatory recruiter questions can never be satisfied. The
        request itself is invalid and is rejected before any provider call.
        """
        if (
            self.requestedQuestionCount is not None
            and len(self.job.questions) > self.requestedQuestionCount
        ):
            raise ValueError(
                "Requested question count is lower than the number of mandatory recruiter questions"
            )
        return self

class AssessmentRequest(Contract):
    schemaVersion: Literal["1"]
    aiJobId: Name
    operation: Literal["ASSESSMENT_GENERATION"]
    request: AssessmentInput

class AssessmentQuestion(Contract):
    section: Section
    prompt: Text
    questionType: QuestionType
    points: Annotated[int, Field(strict=True, ge=1, le=100)]
    difficulty: Difficulty
    guidance: Text | None = None
    options: list[Text] = Field(default_factory=list, max_length=20)
    # Phase 4 — the frozen requirement this question verifies, when it verifies
    # one. Must be one of the request's requirementKeys (checked against the
    # request in validate_input, never minted here). A question may legitimately
    # be role-level (null): not every question maps to a single requirement.
    requirementKey: RequirementKey | None = None
    # Phase 6 — the deterministic answer key. Shape by questionType:
    # SINGLE_CHOICE {"choice": "<exact option text>"}, MULTIPLE_CHOICE
    # {"choices": ["<exact option text>", ...]}, None for every text-shaped
    # question (never machine-graded). The validator below proves the shape and
    # option membership HERE, at the contract boundary — the backend worker's
    # zod gate re-checks the same rules, so JobAssessmentQuestion.correctAnswer
    # can only ever hold a key that names real options of its own question.
    correctAnswer: dict[str, Any] | None = None

    @model_validator(mode="after")
    def answer_key_shape(self):
        key = self.correctAnswer
        if self.questionType == "SINGLE_CHOICE":
            if not isinstance(key, dict) or set(key) != {"choice"}:
                raise ValueError('SINGLE_CHOICE requires correctAnswer {"choice": "<option>"}')
            if not self.options or key["choice"] not in self.options:
                raise ValueError("correctAnswer.choice must be one of the question's options")
        elif self.questionType == "MULTIPLE_CHOICE":
            if not isinstance(key, dict) or set(key) != {"choices"}:
                raise ValueError('MULTIPLE_CHOICE requires correctAnswer {"choices": ["<option>", ...]}')
            choices = key["choices"]
            if not isinstance(choices, list) or not choices:
                raise ValueError("correctAnswer.choices must be a non-empty list")
            if (
                any(not isinstance(choice, str) for choice in choices)
                or len(set(choices)) != len(choices)
                or any(choice not in self.options for choice in choices)
            ):
                raise ValueError("correctAnswer.choices must be unique members of the question's options")
        elif key is not None:
            raise ValueError("Text-shaped questions must not carry a correctAnswer key")
        return self

class Assessment(Contract):
    title: Name
    description: Text | None = None
    # Hard platform maximum: the AI can NEVER produce more than 45 questions.
    # A larger response fails schema validation instead of being truncated.
    questions: list[AssessmentQuestion] = Field(max_length=MAX_ASSESSMENT_QUESTIONS)

    def validate_input(self, request: AssessmentInput):
        """Preservation gate, mirroring Analysis.validate_input in spirit.

        The assessment must be non-empty and must address every section that
        carried an approved clarification question. Dropping a section the
        recruiter just clarified is the same class of failure as an analysis
        that drops a supplied skill, so it is rejected rather than persisted.

        Recruiter-entered JobQuestions (request.job.questions) are MANDATORY
        SOURCE INPUT: every recruiter question must survive as an assessment
        question prompt. Match is exact first; a whitespace/case-normalized
        match is accepted only for harmless formatting differences. Anything
        else (semantic rewrite, summary, deletion) is a validation failure.
        """
        if not self.questions:
            raise ValueError("Assessment must contain at least one question")
        covered = {q.section for q in self.questions}
        clarified = {c.section for c in request.clarifications}
        if not clarified.issubset(covered):
            raise ValueError("Assessment must address every clarified section")
        prompts = [q.prompt for q in self.questions]
        norm = lambda s: " ".join(s.split()).lower()
        for question in request.job.questions:
            if any(p == question for p in prompts):
                continue
            if any(norm(p) == norm(question) for p in prompts):
                continue
            raise ValueError("Assessment must preserve every recruiter-entered question")
        # The requested count is an EXACT contract: the assessment carries the
        # requested number of questions — recruiter questions plus AI additions
        # — never more and never fewer. The hard 45 cap is enforced by the
        # schema above; nothing is silently truncated.
        if (
            request.requestedQuestionCount is not None
            and len(self.questions) != request.requestedQuestionCount
        ):
            raise ValueError("Assessment must contain exactly the requested number of questions")
        # Phase 4 — requirement linkage + must-have coverage.
        #
        # 1. A question that cites a requirementKey must cite one of the FROZEN
        #    request requirements — never an invented key. This is the gate that
        #    keeps the backend's REQ_n keys authoritative.
        # 2. Every MUST_HAVE requirement whose category is assessable (SKILL,
        #    TOOL, RESPONSIBILITY, EXPERIENCE, EDUCATION) must be covered by at
        #    least one question. Employment type / work mode / location are role
        #    context and are deliberately NOT required to be assessed.
        #
        # Coverage is checked only when the request actually carried requirements
        # (a structured job); legacy jobs carry none and keep the old behaviour.
        if request.requirements:
            valid_keys = {r.requirementKey for r in request.requirements}
            for question in self.questions:
                if question.requirementKey is not None and question.requirementKey not in valid_keys:
                    raise ValueError("Question cites a requirementKey that is not in the frozen requirement set")
            covered_keys = {q.requirementKey for q in self.questions if q.requirementKey is not None}
            missing = [
                r.requirementKey
                for r in request.requirements
                if r.priority == "MUST_HAVE"
                and r.category in ASSESSABLE_REQUIREMENT_CATEGORIES
                and r.requirementKey not in covered_keys
            ]
            if missing:
                raise ValueError("Assessment must cover every assessable MUST_HAVE requirement")
        return self

class AssessmentResponse(Contract):
    schemaVersion: Literal["1"] = "1"
    aiJobId: Name
    operation: Literal["ASSESSMENT_GENERATION"] = "ASSESSMENT_GENERATION"
    provider: Literal["gemini"] = "gemini"
    model: Name
    assessment: Assessment

# ---------------------------------------------------------------------------
# Candidate analysis (Phase 7, Step 3)
#
# This is a complete, sanitized evidence snapshot. The contract intentionally
# has no email, token, answer-key, integrity, database, or recruiter-auth field.
# Every nested model inherits Contract, so accidental extra fields are rejected
# before provider execution.
# ---------------------------------------------------------------------------

MAX_CANDIDATE_ANALYSIS_QUESTIONS = 45
MAX_CANDIDATE_ANSWER_LENGTH = 4000
MAX_CANDIDATE_EVIDENCE_TEXT = 20000
MAX_CANDIDATE_REFERENCE_TEXT = 10000

CandidateAnalysisEvidenceStatus = Literal[
    "AVAILABLE", "NOT_PROVIDED", "UNAVAILABLE", "INSUFFICIENT"
]
CandidateAnalysisAlignmentStatus = Literal[
    "SUPPORTED", "NOT_EVIDENCED", "UNAVAILABLE", "CONFLICTING"
]
CandidateAnalysisAssessmentStatus = Literal[
    "NOT_STARTED", "STARTED", "IN_PROGRESS", "SUBMITTED", "TIMED_UP", "CHEATED"
]
CandidateAnalysisQuestionResultStatus = Literal[
    "ANSWERED", "UNANSWERED", "UNAVAILABLE"
]

class CandidateAnalysisMetadata(Contract):
    source: Literal["NODE_WORKER"] = "NODE_WORKER"

class CandidateAnalysisAnswer(Contract):
    answer: Annotated[str, Field(strict=True, max_length=MAX_CANDIDATE_ANSWER_LENGTH)]
    truncated: bool

class CandidateAnalysisQuestion(Contract):
    question: Text
    questionType: QuestionType
    points: Annotated[int, Field(strict=True, ge=0, le=100)]
    candidateAnswer: CandidateAnalysisAnswer | None = None
    earnedPoints: Annotated[int, Field(strict=True, ge=0, le=100)] | None = None
    unanswered: bool = False

    @model_validator(mode="after")
    def answer_state_is_explicit(self):
        if self.unanswered and self.candidateAnswer is not None:
            raise ValueError("An unanswered question cannot carry a candidate answer")
        if not self.unanswered and self.candidateAnswer is None:
            raise ValueError("An answered question must carry a candidate answer")
        return self

class CandidateAnalysisAssessment(Contract):
    title: Name
    description: Text | None = None
    status: CandidateAnalysisAssessmentStatus
    score: Annotated[int, Field(strict=True, ge=0, le=100000)] | None = None
    maxScore: Annotated[int, Field(strict=True, ge=0, le=100000)] | None = None
    scorePercentage: Annotated[float, Field(strict=True, ge=0, le=100)] | None = None
    unanswered: bool = False
    questions: list[CandidateAnalysisQuestion] = Field(
        max_length=MAX_CANDIDATE_ANALYSIS_QUESTIONS
    )

class CandidateAnalysisJob(Contract):
    title: Name
    yearsExperience: Annotated[int, Field(strict=True, ge=0, le=100)] | None = None
    description: Annotated[str, Field(strict=True, min_length=1, max_length=30000)]
    skills: list[Skill] = Field(max_length=100)
    tools: list[Name] = Field(max_length=100)
    recruiterQuestions: list[Text] = Field(max_length=100)
    responsibilities: list[Text] = Field(default_factory=list, max_length=50)
    # Phase 4 — the SAME frozen, backend-keyed requirements used for assessment
    # generation, so a candidate is evaluated against exactly what the assessment
    # tested. Optional (default empty) for legacy jobs with no requirement set.
    requirements: list[KeyedRequirement] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def unique_names(self):
        if len({skill.name for skill in self.skills}) != len(self.skills):
            raise ValueError("Duplicate skill names")
        if len(set(self.tools)) != len(self.tools):
            raise ValueError("Duplicate tool names")
        return self

class CandidateAnalysisEvidence(Contract):
    status: CandidateAnalysisEvidenceStatus
    text: Annotated[
        str, Field(strict=True, max_length=MAX_CANDIDATE_EVIDENCE_TEXT)
    ] | None = None

    @model_validator(mode="after")
    def status_matches_text(self):
        if self.status == "AVAILABLE" and self.text is None:
            raise ValueError("AVAILABLE evidence requires text")
        if self.status != "AVAILABLE" and self.text is not None:
            raise ValueError("Unavailable or unprovided evidence cannot carry text")
        return self

class CandidateAnalysisCandidate(Contract):
    candidateName: Name | None = None
    preferredRole: Text | None = None
    skills: list[Name] = Field(default_factory=list, max_length=100)
    skillNotes: Text | None = None
    linkedinUrl: Annotated[str, Field(strict=True, max_length=2000)] | None = None
    linkedinText: Annotated[str, Field(strict=True, max_length=MAX_CANDIDATE_REFERENCE_TEXT)] | None = None
    linkedinEvidenceStatus: CandidateAnalysisEvidenceStatus = "NOT_PROVIDED"
    githubUrl: Annotated[str, Field(strict=True, max_length=2000)] | None = None
    githubText: Annotated[str, Field(strict=True, max_length=MAX_CANDIDATE_REFERENCE_TEXT)] | None = None
    githubEvidenceStatus: CandidateAnalysisEvidenceStatus = "NOT_PROVIDED"
    resumeText: Annotated[str, Field(strict=True, max_length=MAX_CANDIDATE_EVIDENCE_TEXT)] | None = None
    resumeEvidenceStatus: CandidateAnalysisEvidenceStatus = "NOT_PROVIDED"

    @model_validator(mode="after")
    def evidence_statuses_match_text(self):
        for status, text in (
            (self.linkedinEvidenceStatus, self.linkedinText),
            (self.githubEvidenceStatus, self.githubText),
            (self.resumeEvidenceStatus, self.resumeText),
        ):
            if status == "AVAILABLE" and text is None:
                raise ValueError("AVAILABLE candidate evidence requires text")
            if status != "AVAILABLE" and text is not None:
                raise ValueError("Unavailable candidate evidence cannot carry text")
        return self

class CandidateAnalysisInput(Contract):
    schemaVersion: Literal["1"]
    aiJobId: Name
    operation: Literal["CANDIDATE_ANALYSIS"]
    candidateKey: Annotated[
        str, Field(strict=True, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")
    ]
    analysisVersion: Annotated[int, Field(strict=True, ge=1, le=100000)]
    job: CandidateAnalysisJob
    assessment: CandidateAnalysisAssessment | None = None
    candidate: CandidateAnalysisCandidate
    metadata: CandidateAnalysisMetadata

class CandidateAnalysisEvidenceSummary(Contract):
    status: CandidateAnalysisEvidenceStatus
    summary: Text
    details: list[Text] = Field(default_factory=list, max_length=20)

class CandidateAnalysisAssessmentPerformance(Contract):
    status: CandidateAnalysisAssessmentStatus
    score: Annotated[int, Field(strict=True, ge=0, le=100000)] | None = None
    maxScore: Annotated[int, Field(strict=True, ge=0, le=100000)] | None = None
    scorePercentage: Annotated[float, Field(strict=True, ge=0, le=100)] | None = None
    summary: Text
    strengths: list[Text] = Field(default_factory=list, max_length=20)
    gaps: list[Text] = Field(default_factory=list, max_length=20)
    unanswered: int = Field(ge=0, le=45)

class CandidateAnalysisSkillAlignment(Contract):
    skill: Name
    status: CandidateAnalysisAlignmentStatus
    rationale: Text
    evidence: list[Text] = Field(default_factory=list, max_length=20)

class CandidateAnalysisPreferredRoleAlignment(Contract):
    status: CandidateAnalysisAlignmentStatus
    summary: Text
    rationale: Text

# Phase 4 — one frozen requirement evaluated against the supplied evidence.
# The requirementKey cites a REAL frozen requirement (validated against the
# request in the service layer). Status is one of the four evidence verdicts.
class CandidateAnalysisRequirementEvaluation(Contract):
    requirementKey: RequirementKey
    status: CandidateAnalysisAlignmentStatus
    rationale: Text
    evidence: list[Text] = Field(default_factory=list, max_length=20)

# Phase 4 — a QUALITATIVE job-fit narrative. Deliberately carries NO numeric
# score: the model is forbidden from inventing a fit percentage, and the
# deterministic must-have coverage counts are computed by the backend, never
# here. fitStatement is the single-sentence qualitative bottom line.
class CandidateAnalysisOverallJobFit(Contract):
    summary: Text
    strengths: list[Text] = Field(default_factory=list, max_length=50)
    gaps: list[Text] = Field(default_factory=list, max_length=50)
    fitStatement: Text

class CandidateAnalysis(Contract):
    jobFitSummary: Text
    assessmentPerformance: CandidateAnalysisAssessmentPerformance
    skillAlignment: list[CandidateAnalysisSkillAlignment] = Field(max_length=100)
    resumeEvidence: CandidateAnalysisEvidenceSummary
    linkedinEvidence: CandidateAnalysisEvidenceSummary
    githubEvidence: CandidateAnalysisEvidenceSummary
    preferredRoleAlignment: CandidateAnalysisPreferredRoleAlignment
    strengths: list[Text] = Field(default_factory=list, max_length=50)
    skillGaps: list[Text] = Field(default_factory=list, max_length=50)
    missingRequirements: list[Text] = Field(default_factory=list, max_length=50)
    conflicts: list[Text] = Field(default_factory=list, max_length=50)
    concerns: list[Text] = Field(default_factory=list, max_length=50)
    finalRecruiterReview: Text
    # Phase 4 — one evaluation per frozen requirement, and the qualitative
    # overall fit. Both optional (default empty / synthesized) so a legacy-shaped
    # response that predates them still validates. The deterministic must-have
    # coverage counts are NOT here — the backend computes them from these
    # evaluations plus the frozen requirement priorities.
    requirementEvaluations: list[CandidateAnalysisRequirementEvaluation] = Field(
        default_factory=list, max_length=200
    )
    overallJobFit: CandidateAnalysisOverallJobFit | None = None

class CandidateAnalysisResponse(Contract):
    schemaVersion: Literal["1"] = "1"
    aiJobId: Name
    operation: Literal["CANDIDATE_ANALYSIS"] = "CANDIDATE_ANALYSIS"
    provider: Literal["gemini"] = "gemini"
    model: Name
    analysis: CandidateAnalysis


