from app.errors import ServiceError
from app.schemas import CandidateAnalysis, CandidateAnalysisResponse


def _validate_requirement_evaluations(analysis, envelope):
    """The model may only cite requirement keys that were actually supplied.

    A hallucinated or misspelled requirementKey would silently break the
    backend's deterministic must-have coverage, so an evaluation that cites a
    key outside the frozen request set is rejected here (mirrors the backend
    gate). Only enforced when the request actually carried requirements, so a
    legacy job with no requirement set is unaffected.
    """
    valid_keys = {r.requirementKey for r in envelope.job.requirements}
    if not valid_keys:
        return
    for evaluation in analysis.requirementEvaluations:
        if evaluation.requirementKey not in valid_keys:
            raise ValueError("Requirement evaluation cites an unknown requirementKey")


async def analyze_candidate(envelope, provider, model):
    """Run one stateless, sanitized candidate-analysis provider request."""
    result = await provider.analyze_candidate(envelope)
    try:
        analysis = CandidateAnalysis.model_validate(result)
        _validate_requirement_evaluations(analysis, envelope)
        response = CandidateAnalysisResponse(
            aiJobId=envelope.aiJobId,
            model=model,
            analysis=analysis,
        )
        if len(response.model_dump_json().encode("utf-8")) > 262144:
            raise ValueError("Oversized response")
        return response
    except (ValueError, TypeError):
        raise ServiceError("AI_RESPONSE_VALIDATION_FAILED", 502) from None
