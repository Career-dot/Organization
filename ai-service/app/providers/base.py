from typing import Protocol
from app.schemas import (
    JobInput,
    Analysis,
    AssessmentInput,
    Assessment,
    CandidateAnalysis,
    CandidateAnalysisInput,
)


class AnalysisProvider(Protocol):
    async def analyze(self, job: JobInput) -> Analysis: ...
    async def generate_assessment(self, request: AssessmentInput) -> Assessment: ...
    async def analyze_candidate(self, request: CandidateAnalysisInput) -> CandidateAnalysis: ...
    async def close(self) -> None: ...
