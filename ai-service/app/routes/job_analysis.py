from fastapi import APIRouter, Depends, Request
from app.schemas import AnalysisRequest, AnalysisResponse
from app.security import authenticate
from app.services.job_analysis import analyze_job

router = APIRouter()

@router.post("/internal/v1/job-analysis", response_model=AnalysisResponse, dependencies=[Depends(authenticate)])
async def job_analysis(body: AnalysisRequest, request: Request):
    return await analyze_job(body, request.app.state.provider, request.app.state.settings.gemini_model)
