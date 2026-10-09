from app.schemas import Analysis, AnalysisResponse
from app.errors import ServiceError


async def analyze_job(envelope, provider, model):
    result = await provider.analyze(envelope.request)
    try:
        analysis = Analysis.model_validate(result).validate_input(envelope.request)
        response = AnalysisResponse(aiJobId=envelope.aiJobId, model=model, analysis=analysis)
        if len(response.model_dump_json().encode("utf-8")) > 262144:
            raise ValueError("Oversized response")
        return response
    except (ValueError, TypeError):
        raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None
