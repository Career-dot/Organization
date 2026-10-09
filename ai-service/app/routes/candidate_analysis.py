from fastapi import APIRouter, Depends, Request
from app.schemas import CandidateAnalysisInput, CandidateAnalysisResponse
from app.security import authenticate
from app.services.candidate_analysis import analyze_candidate

router = APIRouter()


@router.post(
    "/internal/v1/candidate-analysis",
    response_model=CandidateAnalysisResponse,
    dependencies=[Depends(authenticate)],
)
async def candidate_analysis(body: CandidateAnalysisInput, request: Request):
    return await analyze_candidate(body, request.app.state.provider, request.app.state.settings.gemini_model)
