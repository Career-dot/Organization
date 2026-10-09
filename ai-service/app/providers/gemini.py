import asyncio
import copy
import httpx
from google import genai
from google.genai import types, errors
from app.errors import ServiceError, retry_hint
from app.schemas import Analysis, Assessment, CandidateAnalysis, CandidateAnalysisInput
from app.prompts.assessment_generation import SYSTEM_PROMPT as ASSESSMENT_SYSTEM_PROMPT
from app.prompts.candidate_analysis import SYSTEM_PROMPT as CANDIDATE_ANALYSIS_SYSTEM_PROMPT
from app.prompts.job_analysis import SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Response schema, expressed in what the Gemini structured-output API accepts.
#
# The pydantic models are the contract, but their JSON Schema cannot be sent
# verbatim: the API rejects two constructs that pydantic emits. Both were
# confirmed against the live API (400 INVALID_ARGUMENT otherwise):
#
#   1. `additionalProperties` — emitted for every model because the schemas use
#      extra="forbid". The Schema proto has no such field, and the API names it
#      explicitly ("Unknown name \"additional_properties\"").
#   2. `minItems`/`maxItems` — rejected on an array that is nested inside another
#      property (skillAnalysis, toolAnalysis). Confirmed by bisection: removing
#      only this pair turns a 400 into a success.
#
# `enum` inside array items (`skillAnalysis[].source`) IS accepted and is kept:
# it must be, because without it the model emits arbitrary strings there
# (observed: "skills"), which Analysis validation then rejects. An earlier
# bisection pass wrongly flagged this enum as the rejected construct; re-verified
# live that keeping it returns 200 while the minItems/maxItems pair alone flips
# the request to 400.
#
# `$defs`/`$ref` are inlined as well, since the referenced definitions are a
# pydantic-internal $ref scheme the service cannot resolve.
#
# Dropping these changes ONLY the schema sent as guidance. Every dropped
# constraint is still enforced, harder, on the JSON that comes back:
# Analysis.model_validate_json() applies extra="forbid", the Literal[...] source
# values and the list max_length limits, and validate_input() re-checks that the
# analysis preserves exactly the supplied skills, weights and tools.
# ---------------------------------------------------------------------------

DROPPED_KEYS = frozenset({"additionalProperties", "minItems", "maxItems"})

def _inline_refs(node, defs, depth=0):
    """Resolves pydantic's $ref/$defs into a self-contained schema."""
    if depth > 25:
        return {}
    if isinstance(node, dict):
        if "$ref" in node:
            name = node["$ref"].split("/")[-1]
            resolved = _inline_refs(copy.deepcopy(defs.get(name, {})), defs, depth + 1)
            return {**resolved, **{k: v for k, v in node.items() if k != "$ref"}}
        return {k: _inline_refs(v, defs, depth + 1) for k, v in node.items() if k != "$defs"}
    if isinstance(node, list):
        return [_inline_refs(item, defs, depth + 1) for item in node]
    return node


def _to_api_schema(node):
    """Drops the constructs the API rejects, preserving everything else."""
    if isinstance(node, list):
        return [_to_api_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    return {k: _to_api_schema(v) for k, v in node.items() if k not in DROPPED_KEYS}


def api_response_schema(model):
    raw = model.model_json_schema()
    return _to_api_schema(_inline_refs(raw, raw.get("$defs", {})))


class GeminiProvider:
    def __init__(self, settings):
        self.settings = settings
        self.client = None
        if settings.gemini_api_key.get_secret_value().strip():
            self.client = genai.Client(
                api_key=settings.gemini_api_key.get_secret_value(),
                http_options=types.HttpOptions(
                    timeout=settings.gemini_request_timeout_ms,
                    retry_options=types.HttpRetryOptions(attempts=1),
                ),
            )

    async def close(self):
        if self.client:
            await self.client.aio.aclose()
            self.client.close()

    async def _generate_text(self, contents, schema_model, system_prompt):
        """One structured-output call, with the provider error mapping applied.

        Shared by both operations so the timeout/rate-limit/safety taxonomy and
        the response ceilings cannot drift between them.
        """
        if not self.client:
            raise ServiceError("AI_PROVIDER_NOT_CONFIGURED", 503)
        try:
            async with asyncio.timeout(self.settings.gemini_request_timeout_ms / 1000):
                response = await self.client.aio.models.generate_content(
                    model=self.settings.gemini_model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        response_mime_type="application/json",
                        response_schema=api_response_schema(schema_model),
                        max_output_tokens=8192,
                    ),
                )
        except (TimeoutError, httpx.TimeoutException):
            raise ServiceError("AI_PROVIDER_TIMEOUT", 504) from None
        except httpx.RequestError:
            raise ServiceError("AI_PROVIDER_NETWORK_ERROR", 503) from None
        except errors.APIError as error:
            code = error.code
            hint = retry_hint(getattr(getattr(error, "response", None), "headers", None))
            if code == 429:
                raise ServiceError("AI_PROVIDER_RATE_LIMITED", 429, hint) from None
            if code and 500 <= code < 600:
                raise ServiceError("AI_PROVIDER_UNAVAILABLE", 503, hint) from None
            raise ServiceError("AI_PROVIDER_CONFIGURATION_ERROR", 503) from None
        except Exception:
            raise ServiceError("AI_SERVICE_INTERNAL_ERROR", 500) from None
        if getattr(getattr(response, "prompt_feedback", None), "block_reason", None):
            raise ServiceError("AI_PROVIDER_SAFETY_BLOCKED", 422)
        for candidate in response.candidates or []:
            finish = str(candidate.finish_reason or "")
            if any(reason in finish for reason in ("SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION")):
                raise ServiceError("AI_PROVIDER_SAFETY_BLOCKED", 422)
        try:
            text = response.text
            if not text or len(text.encode("utf-8")) > 262144:
                raise ValueError("Invalid response length")
            return text
        except (ValueError, TypeError):
            raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None

    async def analyze(self, job):
        text = await self._generate_text(job.model_dump_json(), Analysis, SYSTEM_PROMPT)
        try:
            return Analysis.model_validate_json(text).validate_input(job)
        except (ValueError, TypeError):
            raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None

    async def analyze_candidate(self, request: CandidateAnalysisInput):
        text = await self._generate_text(
            request.model_dump_json(), CandidateAnalysis, CANDIDATE_ANALYSIS_SYSTEM_PROMPT
        )
        try:
            return CandidateAnalysis.model_validate_json(text)
        except (ValueError, TypeError):
            raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None

    async def generate_assessment(self, request):
        text = await self._generate_text(
            request.model_dump_json(), Assessment, ASSESSMENT_SYSTEM_PROMPT
        )
        try:
            return Assessment.model_validate_json(text).validate_input(request)
        except (ValueError, TypeError):
            raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None
