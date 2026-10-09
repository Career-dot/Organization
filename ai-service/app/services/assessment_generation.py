from app.schemas import Assessment, AssessmentResponse
from app.errors import ServiceError


async def generate_assessment(envelope, provider, model):
    result = await provider.generate_assessment(envelope.request)
    try:
        assessment = Assessment.model_validate(result).validate_input(envelope.request)
        response = AssessmentResponse(aiJobId=envelope.aiJobId, model=model, assessment=assessment)
        if len(response.model_dump_json().encode("utf-8")) > 262144:
            raise ValueError("Oversized response")
        return response
    except (ValueError, TypeError):
        raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None
