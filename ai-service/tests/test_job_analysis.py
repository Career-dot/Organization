from copy import deepcopy
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.errors import ServiceError

BODY = {"schemaVersion": "1", "aiJobId": "test-job", "operation": "JOB_ANALYSIS", "request": {
    "title": "Backend Engineer", "yearsExperience": 5, "description": "Build Node.js services.",
    "skills": [{"name": "Node.js", "weight": 100}], "tools": ["Docker"], "questions": []}}
OUTPUT = {"summary": "Backend role", "responsibilities": ["Build services"], "skillAnalysis": [
    {"name": "Node.js", "weight": 100, "expectation": "Build services", "source": "EXPLICIT"}],
    "toolAnalysis": [{"name": "Docker", "expectation": "Use Docker"}], "requirements": [],
    "ambiguities": [], "clarificationQuestions": [], "warnings": []}

class Provider:
    def __init__(self):
        self.calls = 0
        self.output = deepcopy(OUTPUT)
        self.error = None
    async def analyze(self, job):
        self.calls += 1
        if self.error:
            raise self.error
        return self.output
    async def close(self):
        pass

@pytest.fixture
def pair():
    provider = Provider()
    settings = Settings(_env_file=None, ai_service_api_key="test-service-key", gemini_api_key="")
    with TestClient(create_app(settings, lambda _: provider)) as client:
        yield client, provider

@pytest.mark.parametrize("auth", [None, "", "Basic test-service-key", "Bearer ", "Bearer wrong"])
def test_auth_rejects_before_provider(pair, auth):
    client, provider = pair
    response = client.post("/internal/v1/job-analysis", json=BODY, headers={} if auth is None else {"Authorization": auth})
    assert response.status_code == 401
    assert provider.calls == 0

def test_valid_analysis(pair):
    client, provider = pair
    response = client.post("/internal/v1/job-analysis", json=BODY, headers={"Authorization": "Bearer test-service-key"})
    assert response.status_code == 200
    assert response.json() == {"schemaVersion": "1", "aiJobId": "test-job", "operation": "JOB_ANALYSIS",
        "provider": "gemini", "model": "gemini-flash-lite-latest", "analysis": OUTPUT}
    assert provider.calls == 1

@pytest.mark.parametrize("field,value", [("operation", "OTHER"), ("schemaVersion", "2"), ("aiJobId", "")])
def test_invalid_request(pair, field, value):
    client, provider = pair
    body = deepcopy(BODY)
    body[field] = value
    response = client.post("/internal/v1/job-analysis", json=body, headers={"Authorization": "Bearer test-service-key"})
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "AI_REQUEST_INVALID"}}
    assert provider.calls == 0

@pytest.mark.parametrize("status,code", [(429, "AI_PROVIDER_RATE_LIMITED"), (504, "AI_PROVIDER_TIMEOUT"), (503, "AI_PROVIDER_UNAVAILABLE")])
def test_normalized_error(pair, status, code):
    client, provider = pair
    provider.error = ServiceError(code, status, 1000)
    response = client.post("/internal/v1/job-analysis", json=BODY, headers={"Authorization": "Bearer test-service-key"})
    assert response.status_code == status
    assert response.json() == {"error": {"code": code, "retryAfterMs": 1000}}

def test_wrong_weights_rejected(pair):
    client, provider = pair
    provider.output["skillAnalysis"][0]["weight"] = 50
    response = client.post("/internal/v1/job-analysis", json=BODY, headers={"Authorization": "Bearer test-service-key"})
    assert response.status_code == 502
