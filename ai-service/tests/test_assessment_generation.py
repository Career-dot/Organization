from copy import deepcopy
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.errors import ServiceError

SERVICE_KEY = "test-service-key"

ANALYSIS_BODY = {
    "schemaVersion": "1",
    "aiJobId": "analysis-job",
    "operation": "JOB_ANALYSIS",
    "request": {
        "title": "Backend Engineer",
        "yearsExperience": 5,
        "description": "Build Node.js services.",
        "skills": [{"name": "Node.js", "weight": 100}],
        "tools": ["Docker"],
        "questions": [],
    },
}

# One request body per scenario. The deterministic provider keys behaviour off
# request.job.title, so the title is the control channel.
RECRUITER_QUESTIONS = [
    "Which Python framework would you choose for this backend and why?",
    "Explain how you would design the authentication layer.",
    "How would you optimize this API under heavy traffic?",
]


def assessment_body(title, questions, requested_question_count=None, requested_duration_seconds=None):
    request = {
        "job": {
            "title": title,
            "yearsExperience": 5,
            "description": "Build Node.js services.",
            "skills": [{"name": "Node.js", "weight": 100}],
            "tools": ["Docker"],
            "questions": questions,
        },
        "clarifications": [],
    }
    if requested_question_count is not None:
        request["requestedQuestionCount"] = requested_question_count
    if requested_duration_seconds is not None:
        request["requestedDurationSeconds"] = requested_duration_seconds
    return {
        "schemaVersion": "1",
        "aiJobId": "assess-job",
        "operation": "ASSESSMENT_GENERATION",
        "request": request,
    }


class Provider:
    """Deterministic test double mirroring integration_app.TestProvider."""

    def __init__(self):
        self.calls = {}

    async def analyze(self, job):
        # Not used by these tests, but the Protocol requires it.
        raise ServiceError("AI_SERVICE_INTERNAL_ERROR", 500)

    @staticmethod
    def _filler(index, total):
        sections = ["JOB_OVERVIEW", "RESPONSIBILITIES", "REQUIRED_SKILLS", "TOOLS_SOFTWARE"]
        return {
            "section": sections[index % len(sections)],
            "prompt": f"Additional scenario {index + 1} of {total}: apply the core skills.",
            "questionType": "SCENARIO", "points": 10,
            "difficulty": "INTERMEDIATE", "guidance": "Guidance.", "options": [],
        }

    @classmethod
    def _question_dicts(cls, request, requested_count=None, drop_first_question=False):
        questions = []
        for index, text in enumerate(request.job.questions):
            if drop_first_question and index == 0:
                continue
            questions.append({
                "section": "REQUIRED_SKILLS", "prompt": text,
                "questionType": "SHORT_ANSWER", "points": 10,
                "difficulty": "INTERMEDIATE", "guidance": "Guidance.", "options": [],
            })
        if requested_count is None:
            requested_count = request.requestedQuestionCount
        if requested_count is not None:
            filler_total = max(requested_count - len(questions), 0)
            for offset in range(filler_total):
                questions.append(cls._filler(len(questions), filler_total))
        return questions

    @classmethod
    def _raw_assessment(cls, request, requested_count):
        # RAW dict on purpose: an oversized/wrong-count response must fail the
        # SERVICE's validation exactly like a real provider payload would.
        return {
            "title": "Deterministic test assessment",
            "description": "Deterministic description.",
            "questions": cls._question_dicts(request, requested_count=requested_count),
        }

    async def generate_assessment(self, request):
        title = request.job.title
        self.calls[f"assess:{title}"] = self.calls.get(f"assess:{title}", 0) + 1
        if title == "Assess46":
            # Simulates an AI that ignores the 45-question platform cap.
            return self._raw_assessment(request, requested_count=46)
        if title == "AssessWrongCount":
            # Plausible but the wrong total: the requested count is an exact
            # contract, so one question off must be rejected.
            requested = request.requestedQuestionCount or len(request.job.questions)
            return self._raw_assessment(request, requested_count=max(requested - 1, 1))
        questions = self._question_dicts(
            request, drop_first_question=title == "AssessMissingQuestion"
        )
        return _assessment_model(questions)

    async def close(self):
        pass


def _assessment_model(questions):
    from app.schemas import Assessment
    return Assessment(title="Deterministic test assessment",
                       description="Deterministic description.", questions=questions)


@pytest.fixture
def pair():
    provider = Provider()
    settings = Settings(_env_file=None, ai_service_api_key=SERVICE_KEY, gemini_api_key="")
    with TestClient(create_app(settings, lambda _: provider)) as client:
        yield client, provider


def headers():
    return {"Authorization": f"Bearer {SERVICE_KEY}"}


def test_recruiter_questions_survive_generation(pair):
    """Every recruiter-entered question appears verbatim in the assessment."""
    client, provider = pair
    body = assessment_body("Staff Backend Engineer", RECRUITER_QUESTIONS)
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 200, response.text
    assessment = response.json()["assessment"]
    prompts = [q["prompt"] for q in assessment["questions"]]
    for question in RECRUITER_QUESTIONS:
        assert question in prompts, summarize(prompts)


def test_missing_recruiter_question_is_rejected(pair):
    """The service gate must reject a response that drops a recruiter question."""
    client, provider = pair
    body = assessment_body("AssessMissingQuestion", RECRUITER_QUESTIONS)
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 502
    assert response.json() == {"error": {"code": "AI_RESPONSE_VALIDATION_FAILED"}}
    # The provider was still called (it generated a partial response), but the
    # service refused to return it.
    assert provider.calls.get("assess:AssessMissingQuestion", 0) == 1


def test_auth_rejects_assessment_before_provider(pair):
    client, provider = pair
    body = assessment_body("Staff Backend Engineer", RECRUITER_QUESTIONS)
    response = client.post("/internal/v1/assessment-generation", json=body)
    assert response.status_code == 401
    assert provider.calls == {}


def test_unauthenticated_cannot_reveal_provider_error(pair):
    """No provider error code leaks to an unauthenticated caller."""
    client, provider = pair
    body = assessment_body("AssessMissingQuestion", RECRUITER_QUESTIONS)
    response = client.post("/internal/v1/assessment-generation", json=body)
    assert response.status_code == 401
    assert "AI_RESPONSE_VALIDATION_FAILED" not in response.text


# --- requested count / duration contract (assessment settings stage) ---------

def test_requested_count_is_respected(pair):
    """requestedQuestionCount is an EXACT contract: recruiter questions + AI fill."""
    client, _ = pair
    body = assessment_body(
        "Counted Staff Engineer", RECRUITER_QUESTIONS, requested_question_count=5
    )
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 200, response.text
    questions = response.json()["assessment"]["questions"]
    assert len(questions) == 5, summarize([q["prompt"] for q in questions])
    prompts = [q["prompt"] for q in questions]
    for question in RECRUITER_QUESTIONS:
        assert question in prompts
    # The extra question is AI-added and distinct from every recruiter question.
    assert all(prompt in RECRUITER_QUESTIONS or prompt.startswith("Additional scenario") for prompt in prompts)


def test_wrong_count_is_rejected(pair):
    client, _ = pair
    body = assessment_body(
        "AssessWrongCount", RECRUITER_QUESTIONS, requested_question_count=5
    )
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 502
    assert response.json() == {"error": {"code": "AI_RESPONSE_VALIDATION_FAILED"}}


def test_46_question_response_is_rejected(pair):
    """The hard platform cap: a 46-question AI response must never validate."""
    client, _ = pair
    body = assessment_body(
        "Assess46", RECRUITER_QUESTIONS, requested_question_count=6
    )
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 502
    assert response.json() == {"error": {"code": "AI_RESPONSE_VALIDATION_FAILED"}}


def test_requested_count_below_recruiter_questions_rejected_before_provider(pair):
    client, provider = pair
    body = assessment_body("Impossible Config", RECRUITER_QUESTIONS, requested_question_count=2)
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "AI_REQUEST_INVALID"}}
    # The request itself is invalid: the provider was never called.
    assert provider.calls.get("assess:Impossible Config", 0) == 0


def test_requested_count_above_45_rejected_before_provider(pair):
    client, provider = pair
    body = assessment_body("Too Many", RECRUITER_QUESTIONS, requested_question_count=46)
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "AI_REQUEST_INVALID"}}
    assert provider.calls.get("assess:Too Many", 0) == 0


def test_invalid_duration_rejected_before_provider(pair):
    client, _ = pair
    for bad in (5401, 59):
        body = assessment_body(
            f"Bad Duration {bad}", RECRUITER_QUESTIONS, requested_duration_seconds=bad
        )
        response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
        assert response.status_code == 422, f"{bad}: {response.text}"
        assert response.json() == {"error": {"code": "AI_REQUEST_INVALID"}}


def test_valid_duration_accepted_and_never_in_response(pair):
    """5400s (90 minutes) is accepted; duration is NEVER part of the response."""
    client, _ = pair
    body = assessment_body(
        "Capped Duration",
        RECRUITER_QUESTIONS,
        requested_question_count=4,
        requested_duration_seconds=5400,
    )
    response = client.post("/internal/v1/assessment-generation", json=body, headers=headers())
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["assessment"]["questions"]) == 4
    assert "durationSeconds" not in payload
    assert "durationSeconds" not in payload["assessment"]


def summarize(value):
    import json
    return json.dumps(value, default=str)
