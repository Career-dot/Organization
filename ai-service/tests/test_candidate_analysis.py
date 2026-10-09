from copy import deepcopy
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from google.genai import errors

from app.config import Settings
from app.errors import ServiceError
from app.main import create_app
from app.providers.gemini import GeminiProvider, api_response_schema
from app.schemas import CandidateAnalysis, CandidateAnalysisInput

KEY = "test-service-key"
HEADERS = {"Authorization": f"Bearer {KEY}"}


def body(title="Backend Engineer", **overrides):
    request = {
        "schemaVersion": "1",
        "aiJobId": "candidate-ai-job",
        "operation": "CANDIDATE_ANALYSIS",
        "candidateKey": "candidate_opaque_123",
        "analysisVersion": 1,
        "job": {
            "title": title,
            "yearsExperience": 5,
            "description": "Build reliable backend services with Node.js, PostgreSQL, and Docker.",
            "skills": [
                {"name": "Node.js", "weight": 60},
                {"name": "PostgreSQL", "weight": 40},
            ],
            "tools": ["Docker"],
            "recruiterQuestions": ["How would you design a resilient API?"],
            "responsibilities": ["Build and operate backend services."],
        },
        "assessment": {
            "title": "Backend assessment",
            "description": "Role-specific assessment.",
            "status": "SUBMITTED",
            "score": 8,
            "maxScore": 10,
            "scorePercentage": 80.0,
            "unanswered": False,
            "questions": [
                {
                    "question": "Explain a production database migration.",
                    "questionType": "SHORT_ANSWER",
                    "points": 10,
                    "candidateAnswer": {
                        "answer": "I use a reversible, observable migration process.",
                        "truncated": False,
                    },
                    "earnedPoints": 8,
                    "unanswered": False,
                }
            ],
        },
        "candidate": {
            "candidateName": "Ada Candidate",
            "preferredRole": "Backend Engineer",
            "skills": ["Node.js", "PostgreSQL"],
            "skillNotes": "Supplied recruiter evidence.",
            "linkedinUrl": "https://www.linkedin.com/in/ada",
            "linkedinText": "LinkedIn text supplied as evidence.",
            "linkedinEvidenceStatus": "AVAILABLE",
            "githubUrl": "https://github.com/ada",
            "githubText": "GitHub text supplied as evidence.",
            "githubEvidenceStatus": "AVAILABLE",
            "resumeText": "Resume text supplied as evidence.",
            "resumeEvidenceStatus": "AVAILABLE",
        },
        "metadata": {"source": "NODE_WORKER"},
    }
    request.update(overrides)
    return request


def output():
    return {
        "jobFitSummary": "The supplied evidence supports backend alignment.",
        "assessmentPerformance": {
            "status": "SUBMITTED",
            "score": 8,
            "maxScore": 10,
            "scorePercentage": 80.0,
            "summary": "Assessment results are factual and separate from qualitative fit.",
            "strengths": ["Supplied assessment answer"],
            "gaps": ["No supplied Docker evidence"],
            "unanswered": 0,
        },
        "skillAlignment": [
            {"skill": "Node.js", "status": "SUPPORTED", "rationale": "Candidate skills support alignment.", "evidence": ["Candidate-supplied skill"]},
            {"skill": "PostgreSQL", "status": "SUPPORTED", "rationale": "Assessment answer supports alignment.", "evidence": ["Assessment answer"]},
        ],
        "resumeEvidence": {"status": "AVAILABLE", "summary": "Resume text was supplied.", "details": ["Resume evidence"]},
        "linkedinEvidence": {"status": "AVAILABLE", "summary": "LinkedIn text was supplied.", "details": ["LinkedIn evidence"]},
        "githubEvidence": {"status": "AVAILABLE", "summary": "GitHub text was supplied.", "details": ["GitHub evidence"]},
        "preferredRoleAlignment": {"status": "SUPPORTED", "summary": "Preferred role aligns with the job.", "rationale": "Qualitative decision support only."},
        "strengths": ["Relevant supplied evidence"],
        "skillGaps": ["Docker has no supplied evidence"],
        "missingRequirements": ["No supplied evidence demonstrates Docker"],
        "conflicts": [],
        "concerns": [],
        "finalRecruiterReview": "Review the evidence and make the hiring decision.",
    }


class Provider:
    def __init__(self):
        self.calls = []
        self.error = None
        self.result = output()

    async def analyze_candidate(self, request):
        self.calls.append(request)
        if self.error:
            raise self.error
        result = deepcopy(self.result)
        if all(key in result for key in ("resumeEvidence", "linkedinEvidence", "githubEvidence")):
            result["resumeEvidence"]["status"] = request.candidate.resumeEvidenceStatus
            result["linkedinEvidence"]["status"] = request.candidate.linkedinEvidenceStatus
            result["githubEvidence"]["status"] = request.candidate.githubEvidenceStatus
        return result

    async def close(self):
        pass


@pytest.fixture
def pair():
    provider = Provider()
    settings = Settings(_env_file=None, ai_service_api_key=KEY, gemini_api_key="")
    with TestClient(create_app(settings, lambda _: provider)) as client:
        yield client, provider


def post(client, payload, headers=HEADERS):
    return client.post("/internal/v1/candidate-analysis", json=payload, headers=headers)


def test_valid_candidate_analysis(pair):
    client, provider = pair
    response = post(client, body())
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["operation"] == "CANDIDATE_ANALYSIS"
    assert payload["provider"] == "gemini"
    assert payload["model"] == "gemini-flash-lite-latest"
    assert payload["analysis"]["resumeEvidence"]["status"] == "AVAILABLE"
    assert payload["analysis"]["assessmentPerformance"]["score"] == 8
    assert len(provider.calls) == 1


@pytest.mark.parametrize("auth", [None, "", "Basic test-service-key", "Bearer ", "Bearer wrong"])
def test_auth_rejects_before_provider(pair, auth):
    client, provider = pair
    response = post(client, body(), {} if auth is None else {"Authorization": auth})
    assert response.status_code == 401
    assert provider.calls == []


def test_valid_api_key_is_required(pair):
    client, provider = pair
    assert post(client, body()).status_code == 200
    assert len(provider.calls) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("operation", "JOB_ANALYSIS"),
        ("schemaVersion", "2"),
        ("candidateKey", ""),
        ("candidateKey", "candidate@example.test"),
    ],
)
def test_invalid_top_level_contract(pair, field, value):
    client, provider = pair
    payload = body()
    payload[field] = value
    response = post(client, payload)
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "AI_REQUEST_INVALID"}}
    assert provider.calls == []


def test_raw_email_is_rejected(pair):
    client, provider = pair
    payload = body()
    payload["candidate"]["email"] = "ada@example.test"
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_correct_answer_is_rejected(pair):
    client, provider = pair
    payload = body()
    payload["assessment"]["questions"][0]["correctAnswer"] = {"text": "secret key"}
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_security_metadata_is_rejected(pair):
    client, provider = pair
    payload = body()
    payload["assessment"]["questions"][0]["integrityToken"] = "secret"
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_answer_length_boundary(pair):
    client, provider = pair
    payload = body()
    payload["assessment"]["questions"][0]["candidateAnswer"]["answer"] = "x" * 4000
    assert post(client, payload).status_code == 200

    payload = body()
    payload["assessment"]["questions"][0]["candidateAnswer"]["answer"] = "x" * 4001
    assert post(client, payload).status_code == 422
    assert len(provider.calls) == 1


def test_truncated_answer_cannot_exceed_boundary(pair):
    client, provider = pair
    payload = body()
    answer = payload["assessment"]["questions"][0]["candidateAnswer"]
    answer.update({"answer": "x" * 4001, "truncated": True})
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_question_count_and_malformed_question_are_bounded(pair):
    client, provider = pair
    payload = body()
    question = payload["assessment"]["questions"][0]
    payload["assessment"]["questions"] = [deepcopy(question) for _ in range(46)]
    assert post(client, payload).status_code == 422

    payload = body()
    payload["assessment"]["questions"][0].pop("candidateAnswer")
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_invalid_evidence_status_is_rejected(pair):
    client, provider = pair
    payload = body()
    payload["candidate"]["resumeEvidenceStatus"] = "MAYBE"
    assert post(client, payload).status_code == 422
    assert provider.calls == []


def test_url_without_text_is_not_evidence(pair):
    client, provider = pair
    payload = body()
    payload["candidate"].update(
        {
            "linkedinUrl": "https://www.linkedin.com/in/ada",
            "linkedinText": None,
            "linkedinEvidenceStatus": "NOT_PROVIDED",
            "githubUrl": "https://github.com/ada",
            "githubText": None,
            "githubEvidenceStatus": "NOT_PROVIDED",
        }
    )
    response = post(client, payload)
    assert response.status_code == 200
    assert response.json()["analysis"]["linkedinEvidence"]["status"] == "NOT_PROVIDED"
    assert response.json()["analysis"]["githubEvidence"]["status"] == "NOT_PROVIDED"


def test_resume_unavailable_is_explicit(pair):
    client, provider = pair
    payload = body()
    payload["candidate"].update({"resumeText": None, "resumeEvidenceStatus": "UNAVAILABLE"})
    response = post(client, payload)
    assert response.status_code == 200
    assert response.json()["analysis"]["resumeEvidence"]["status"] == "UNAVAILABLE"


def test_output_has_required_sections_and_no_combined_score(pair):
    client, provider = pair
    payload = post(client, body()).json()
    analysis = payload["analysis"]
    required = {
        "jobFitSummary", "assessmentPerformance", "skillAlignment", "resumeEvidence",
        "linkedinEvidence", "githubEvidence", "preferredRoleAlignment", "strengths",
        "skillGaps", "missingRequirements", "conflicts", "concerns", "finalRecruiterReview",
    }
    assert required <= set(analysis)
    serialized = repr(payload).lower()
    for forbidden in ("overall_score", "combined_score", "candidate_score", "fit_percentage", "weighted_overall_score"):
        assert forbidden not in serialized


@pytest.mark.parametrize(
    "error,status,code",
    [
        (ServiceError("AI_PROVIDER_RATE_LIMITED", 429, 100), 429, "AI_PROVIDER_RATE_LIMITED"),
        (ServiceError("AI_PROVIDER_TIMEOUT", 504), 504, "AI_PROVIDER_TIMEOUT"),
        (ServiceError("AI_PROVIDER_NETWORK_ERROR", 503), 503, "AI_PROVIDER_NETWORK_ERROR"),
        (ServiceError("AI_PROVIDER_UNAVAILABLE", 503), 503, "AI_PROVIDER_UNAVAILABLE"),
        (ServiceError("AI_PROVIDER_SAFETY_BLOCKED", 422), 422, "AI_PROVIDER_SAFETY_BLOCKED"),
    ],
)
def test_provider_errors_map_existing_taxonomy(pair, error, status, code):
    client, provider = pair
    provider.error = error
    response = post(client, body())
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


def test_malformed_provider_output_is_rejected(pair):
    client, provider = pair
    provider.result = {"jobFitSummary": "incomplete"}
    response = post(client, body())
    assert response.status_code == 502
    assert response.json() == {"error": {"code": "AI_RESPONSE_VALIDATION_FAILED"}}


def test_candidate_analysis_code_has_no_business_or_data_clients():
    root = Path(__file__).resolve().parents[1] / "app"
    files = [
        root / "routes" / "candidate_analysis.py",
        root / "services" / "candidate_analysis.py",
        root / "prompts" / "candidate_analysis.py",
    ]
    forbidden_imports = {"asyncpg", "psycopg", "psycopg2", "redis", "bullmq", "prisma", "sqlalchemy"}
    for file in files:
        tree = ast.parse(file.read_text(encoding="utf-8"))
        imports = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        imports |= {
            (node.module or "").split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
        }
        assert not imports & forbidden_imports, (file, imports & forbidden_imports)
        source = file.read_text(encoding="utf-8")
        assert "http://" not in source and "https://" not in source


def test_gemini_candidate_analysis_uses_existing_structured_output_boundary():
    settings = Settings(_env_file=None, gemini_api_key="")
    provider = GeminiProvider(settings)
    call = AsyncMock(
        return_value=SimpleNamespace(
            text=json.dumps(output()), candidates=[], prompt_feedback=None
        )
    )
    provider.client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=call))
    )
    request = CandidateAnalysisInput.model_validate(body())
    result = asyncio.run(provider.analyze_candidate(request))
    assert result.jobFitSummary == output()["jobFitSummary"]
    assert call.await_count == 1
    config = call.call_args.kwargs["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_schema is not None
    assert "untrusted DATA" in config.system_instruction
    assert "candidate@example.test" not in call.call_args.kwargs["contents"]
    schema = api_response_schema(CandidateAnalysis)
    assert "additionalProperties" not in json.dumps(schema)
    assert "minItems" not in json.dumps(schema)
    assert "maxItems" not in json.dumps(schema)
    assert "AVAILABLE" in json.dumps(schema)


@pytest.mark.parametrize(
    "side_effect,code",
    [
        (errors.APIError(429, {"error": {"code": 429}}), "AI_PROVIDER_RATE_LIMITED"),
        (TimeoutError(), "AI_PROVIDER_TIMEOUT"),
        (__import__("httpx").ConnectError("secret"), "AI_PROVIDER_NETWORK_ERROR"),
        (errors.APIError(503, {"error": {"code": 503}}), "AI_PROVIDER_UNAVAILABLE"),
    ],
)
def test_gemini_candidate_analysis_maps_provider_errors(side_effect, code):
    provider = GeminiProvider(Settings(_env_file=None, gemini_api_key=""))
    call = AsyncMock(side_effect=side_effect)
    provider.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=call)))
    with pytest.raises(ServiceError) as caught:
        asyncio.run(provider.analyze_candidate(CandidateAnalysisInput.model_validate(body())))
    assert caught.value.code == code
    assert call.await_count == 1


def test_gemini_candidate_analysis_rejects_malformed_output():
    provider = GeminiProvider(Settings(_env_file=None, gemini_api_key=""))
    call = AsyncMock(return_value=SimpleNamespace(text="{}", candidates=[], prompt_feedback=None))
    provider.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=call)))
    with pytest.raises(ServiceError) as caught:
        asyncio.run(provider.analyze_candidate(CandidateAnalysisInput.model_validate(body())))
    assert caught.value.code == "AI_RESPONSE_VALIDATION_FAILED"
    assert call.await_count == 1


def test_gemini_candidate_analysis_maps_safety_block():
    provider = GeminiProvider(Settings(_env_file=None, gemini_api_key=""))
    call = AsyncMock(return_value=SimpleNamespace(text="{}", candidates=[], prompt_feedback=SimpleNamespace(block_reason="SAFETY")))
    provider.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=call)))
    with pytest.raises(ServiceError) as caught:
        asyncio.run(provider.analyze_candidate(CandidateAnalysisInput.model_validate(body())))
    assert caught.value.code == "AI_PROVIDER_SAFETY_BLOCKED"
    assert call.await_count == 1


def test_gemini_candidate_analysis_requires_configuration():
    provider = GeminiProvider(Settings(_env_file=None, gemini_api_key=""))
    with pytest.raises(ServiceError) as caught:
        asyncio.run(provider.analyze_candidate(CandidateAnalysisInput.model_validate(body())))
    assert caught.value.code == "AI_PROVIDER_NOT_CONFIGURED"


