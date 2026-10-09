"""Real FastAPI app with a deterministic provider, exclusively for integration tests."""
import asyncio
import os
from app.main import create_app
from app.config import Settings
from app.errors import ServiceError
from app.schemas import Analysis, Assessment, CandidateAnalysis

# Sections the deterministic analysis clarifies, in contract order. Chosen to
# include a section with ZERO questions (RESPONSIBILITIES), so the section-count
# UI contract can be tested against a real "AI generated 0 questions" case.
def deterministic_clarifications(job):
    questions = []
    if job.skills:
        questions.append({"section": "REQUIRED_SKILLS",
                          "question": f"How many years of hands-on {job.skills[0].name} should this role require?"})
    if job.tools:
        questions.append({"section": "TOOLS_SOFTWARE",
                          "question": f"Is {job.tools[0]} expected to be used daily?"})
    questions.append({"section": "JOB_OVERVIEW",
                      "question": "Is this position fully remote, hybrid or onsite?"})
    return questions

class TestProvider:
    def __init__(self):
        self.calls = {}

    async def close(self):
        pass

    async def analyze(self, job):
        seen = self.calls[job.title] = self.calls.get(job.title, 0) + 1
        if job.title == "Retry":
            raise ServiceError("AI_PROVIDER_RATE_LIMITED", 429, 100)
        if job.title == "Terminal":
            raise ServiceError("AI_PROVIDER_SAFETY_BLOCKED", 422)
        if job.title == "Mismatch":
            # Fabricates an extra tool: must be rejected by the service's
            # "analysis preserves the supplied input" gate (and by the worker's
            # own re-validation if the service ever let it through).
            return self._result(job, extra_tools=["FabricatedTool"])
        if job.title == "Flaky" and seen == 1:
            raise ServiceError("AI_PROVIDER_UNAVAILABLE", 503)
        if job.title == "Slow":
            await asyncio.sleep(2)
        return self._result(job)

    @staticmethod
    def _analysis(job, extra_tools=()):
        return Analysis(summary="Deterministic test analysis", responsibilities=[],
            skillAnalysis=[dict(name=s.name, weight=s.weight, expectation="Test expectation", source="EXPLICIT") for s in job.skills],
            toolAnalysis=[dict(name=t, expectation="Test expectation") for t in [*job.tools, *extra_tools]],
            ambiguities=[], clarificationQuestions=deterministic_clarifications(job), warnings=[])

    @classmethod
    def _result(cls, job, extra_tools=()):
        return cls._analysis(job, extra_tools=extra_tools)

    async def generate_assessment(self, request):
        title = request.job.title
        seen = self.calls[f"assess:{title}"] = self.calls.get(f"assess:{title}", 0) + 1
        if title == "AssessRetry":
            raise ServiceError("AI_PROVIDER_RATE_LIMITED", 429, 100)
        if title == "AssessFlaky" and seen == 1:
            raise ServiceError("AI_PROVIDER_UNAVAILABLE", 503)
        if title == "AssessIncomplete":
            # Drops a clarified section: the service's preservation gate must
            # reject this rather than persist a partial assessment.
            return self._assessment(request, drop_sections=True)
        if title == "AssessMissingQuestion":
            # Drops the first recruiter question: the service's recruiter-
            # question preservation gate must reject this.
            return self._assessment(request, drop_first_question=True)
        if title == "Assess46":
            # Simulates an AI that ignores the 45-question platform cap: a
            # 46-question response must be rejected by the service's schema.
            return self._assessment_raw(request, requested_count=46)
        if title == "AssessWrongCount":
            # Plausible but the wrong total: the requested count is an exact
            # contract, so one question off must be rejected.
            requested = request.requestedQuestionCount or len(request.job.questions)
            return self._assessment_raw(request, requested_count=max(requested - 1, 1))
        return self._assessment(request)

    async def analyze_candidate(self, request):
        self.calls[f"candidate:{request.candidateKey}"] = self.calls.get(f"candidate:{request.candidateKey}", 0) + 1
        control = request.candidate.candidateName
        if control == "CandidateRetry" or request.job.title == "CandidateRetry":
            raise ServiceError("AI_PROVIDER_RATE_LIMITED", 429, 100)
        if control == "CandidateUnavailable" or request.job.title == "CandidateUnavailable":
            raise ServiceError("AI_PROVIDER_UNAVAILABLE", 503)
        if control == "CandidateTimeout" or request.job.title == "CandidateTimeout":
            await asyncio.sleep(2)
        if control == "CandidateSafety" or request.job.title == "CandidateSafety":
            raise ServiceError("AI_PROVIDER_SAFETY_BLOCKED", 422)
        if control == "CandidateMalformed" or request.job.title == "CandidateMalformed":
            return {"jobFitSummary": "missing required sections"}
        return self._candidate_analysis(request)

    @staticmethod
    def _candidate_analysis(request):
        candidate = request.candidate
        return CandidateAnalysis(
            jobFitSummary="Deterministic evidence-based candidate review.",
            assessmentPerformance={
                "status": request.assessment.status if request.assessment else "NOT_STARTED",
                "score": request.assessment.score if request.assessment else None,
                "maxScore": request.assessment.maxScore if request.assessment else None,
                "scorePercentage": request.assessment.scorePercentage if request.assessment else None,
                "summary": "Assessment evidence is reported separately from qualitative fit.",
                "strengths": [],
                "gaps": [],
                "unanswered": sum(
                    1 for question in request.assessment.questions if question.unanswered
                ) if request.assessment else 0,
            },
            skillAlignment=[
                {
                    "skill": skill.name,
                    "status": "SUPPORTED" if skill.name in candidate.skills else "NOT_EVIDENCED",
                    "rationale": "Based only on supplied candidate evidence.",
                    "evidence": [],
                }
                for skill in request.job.skills
            ],
            resumeEvidence={
                "status": candidate.resumeEvidenceStatus,
                "summary": "Resume evidence status is preserved explicitly.",
                "details": [],
            },
            linkedinEvidence={
                "status": candidate.linkedinEvidenceStatus,
                "summary": "LinkedIn is analyzed only when text is supplied.",
                "details": [],
            },
            githubEvidence={
                "status": candidate.githubEvidenceStatus,
                "summary": "GitHub is analyzed only when text is supplied.",
                "details": [],
            },
            preferredRoleAlignment={
                "status": "SUPPORTED" if candidate.preferredRole else "NOT_EVIDENCED",
                "summary": "Preferred-role alignment is qualitative.",
                "rationale": "No automatic hiring decision is made.",
            },
            strengths=[],
            skillGaps=[],
            missingRequirements=[],
            conflicts=[],
            concerns=[],
            finalRecruiterReview="Review the supplied evidence and make the hiring decision.",
        )

    @staticmethod
    def _filler(index, total):
        sections = ["JOB_OVERVIEW", "RESPONSIBILITIES", "REQUIRED_SKILLS", "TOOLS_SOFTWARE"]
        return {
            "section": sections[index % len(sections)],
            "prompt": (
                f"Additional scenario {index + 1} of {total}: apply the role's core "
                "skills to a concrete situation."
            ),
            "questionType": "SCENARIO",
            "points": 10,
            "difficulty": "INTERMEDIATE",
            "guidance": "Deterministic guidance.",
            "options": [],
        }

    @staticmethod
    def _question_dicts(request, drop_sections=False, drop_first_question=False, requested_count=None):
        questions = []
        # Recruiter-entered questions MUST survive verbatim as assessment
        # questions (preserving text), in the order the recruiter supplied them.
        for index, text in enumerate(request.job.questions):
            if drop_first_question and index == 0:
                continue
            questions.append({
                "section": "REQUIRED_SKILLS",
                "prompt": text,  # exact recruiter text
                "questionType": "SHORT_ANSWER",
                "points": 10,
                "difficulty": "INTERMEDIATE",
                "guidance": "Deterministic guidance.",
                "options": [],
            })
        # AI-generated questions covering the clarified sections.
        for clarification in request.clarifications:
            if drop_sections and clarification.section == "TOOLS_SOFTWARE":
                continue
            questions.append({"section": clarification.section,
                              "prompt": f"Assessment prompt for {clarification.question}",
                              "questionType": "SCENARIO", "points": 10,
                              "difficulty": "INTERMEDIATE", "guidance": "Deterministic guidance.",
                              "options": []})
        # Honor the recruiter's requested total exactly: fill with deterministic
        # AI questions while the recruiter questions stay verbatim and first.
        if requested_count is None:
            requested_count = request.requestedQuestionCount
        if requested_count is not None:
            filler_total = max(requested_count - len(questions), 0)
            for offset in range(filler_total):
                questions.append(TestProvider._filler(len(questions), filler_total))
        return questions

    @classmethod
    def _assessment(cls, request, drop_sections=False, drop_first_question=False):
        return Assessment(title="Deterministic test assessment", description="Deterministic description.",
                          questions=cls._question_dicts(request, drop_sections=drop_sections,
                                                        drop_first_question=drop_first_question))

    @classmethod
    def _assessment_raw(cls, request, requested_count):
        """Returns a RAW dict on purpose: an oversized/wrong-count response must
        fail the SERVICE's validation (model_validate / validate_input) exactly
        like a real provider payload would, not inside this provider."""
        return {
            "title": "Deterministic test assessment",
            "description": "Deterministic description.",
            "questions": cls._question_dicts(request, requested_count=requested_count),
        }

app = create_app(Settings(_env_file=None, ai_service_api_key=os.environ["AI_SERVICE_API_KEY"], gemini_api_key=""), lambda _: TestProvider())
