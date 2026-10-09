from fastapi import APIRouter, Depends, Request
from app.schemas import AssessmentRequest, AssessmentResponse
from app.security import authenticate
from app.services.assessment_generation import generate_assessment

router = APIRouter()

@router.post("/internal/v1/assessment-generation", response_model=AssessmentResponse, dependencies=[Depends(authenticate)])
async def assessment_generation(body: AssessmentRequest, request: Request):
    return await generate_assessment(body, request.app.state.provider, request.app.state.settings.gemini_model)
