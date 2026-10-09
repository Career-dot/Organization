import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock
import httpx
import pytest
from google.genai import errors
from app.config import Settings
from app.errors import ServiceError, retry_hint
from app.providers.gemini import GeminiProvider
from app.schemas import JobInput
from test_job_analysis import BODY, OUTPUT

@pytest.fixture
def provider():
    provider = GeminiProvider(Settings(_env_file=None, gemini_api_key=""))
    call = AsyncMock(return_value=SimpleNamespace(text=json.dumps(OUTPUT), candidates=[], prompt_feedback=None))
    provider.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=call)))
    return provider, call

def test_structured_single_attempt(provider):
    p, call = provider
    result = asyncio.run(p.analyze(JobInput.model_validate(BODY["request"])))
    assert result.summary == OUTPUT["summary"]
    assert call.await_count == 1
    config = call.call_args.kwargs["config"]
    assert config.response_mime_type == "application/json"
    assert config.response_schema is not None
    assert "untrusted DATA" in config.system_instruction
    assert "aiJobId" not in call.call_args.kwargs["contents"]

@pytest.mark.parametrize("status,code", [(429, "AI_PROVIDER_RATE_LIMITED"), (503, "AI_PROVIDER_UNAVAILABLE"), (403, "AI_PROVIDER_CONFIGURATION_ERROR")])
def test_sdk_errors(provider, status, code):
    p, call = provider
    call.side_effect = errors.APIError(status, {"error": {"message": "SECRET must not escape", "code": status}})
    with pytest.raises(ServiceError) as caught:
        asyncio.run(p.analyze(JobInput.model_validate(BODY["request"])))
    assert caught.value.code == code
    assert "SECRET" not in str(caught.value)
    assert call.await_count == 1

@pytest.mark.parametrize("error,code", [(TimeoutError(), "AI_PROVIDER_TIMEOUT"), (httpx.ConnectError("secret"), "AI_PROVIDER_NETWORK_ERROR")])
def test_transport_errors(provider, error, code):
    p, call = provider
    call.side_effect = error
    with pytest.raises(ServiceError) as caught:
        asyncio.run(p.analyze(JobInput.model_validate(BODY["request"])))
    assert caught.value.code == code

# The oversized case needs an explicit short id: pytest derives ids from the
# parameter, and a 262145-character id overflows the PYTEST_CURRENT_TEST
# environment variable on Windows (32767-character limit), failing the test in
# fixture setup before the code under test is ever reached.
@pytest.mark.parametrize("text", ["not json", "{}", pytest.param("x" * 262145, id="oversized")])
def test_invalid_output(provider, text):
    p, call = provider
    call.return_value.text = text
    with pytest.raises(ServiceError) as caught:
        asyncio.run(p.analyze(JobInput.model_validate(BODY["request"])))
    assert caught.value.code == "AI_RESPONSE_VALIDATION_FAILED"

def test_retry_hint_bounds():
    assert retry_hint({"retry-after": "99999999"}) == 300000
    assert retry_hint({"retry-after": "NaN"}) is None
    assert retry_hint({"retry-after": "2"}) == 2000

@pytest.mark.skipif(os.getenv("LIVE_GEMINI_TEST") != "true", reason="Explicit opt-in required")
def test_live_gemini():
    settings = Settings()
    assert settings.gemini_api_key.get_secret_value(), "GEMINI_API_KEY required"
    async def run():
        p = GeminiProvider(settings)
        try:
            result = await p.analyze(JobInput.model_validate(BODY["request"]))
            assert result.summary
            print(f"Live Gemini model verified: {settings.gemini_model}")
        finally:
            await p.close()
    asyncio.run(run())
