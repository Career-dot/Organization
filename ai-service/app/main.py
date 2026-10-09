import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.config import Settings
from app.errors import ServiceError
from app.providers.gemini import GeminiProvider
from app.routes.assessment_generation import router as assessment_router
from app.routes.candidate_analysis import router as candidate_analysis_router
from app.routes.health import router as health_router
from app.routes.job_analysis import router as analysis_router

logger = logging.getLogger("ai-service")


def create_app(settings=None, provider_factory=GeminiProvider) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        app.state.settings = settings or Settings()
        app.state.provider = provider_factory(app.state.settings)

        # Configuration validation, logged as booleans only (see
        # Settings.safe_summary): no key, no prefix, no length ever reaches a log
        # line. Both faults are reported because they surface as different codes
        # to the worker and are fixed in the same file — ai-service/.env.
        summary = app.state.settings.safe_summary()
        logger.info("AI service configured: %s", summary["ai_service_api_key"])
        logger.info("Gemini provider configured: %s", summary["gemini_api_key"])
        if not summary["ai_service_api_key"]:
            logger.error(
                "AI_SERVICE_API_KEY is not set: worker calls are rejected with "
                "AI_SERVICE_NOT_CONFIGURED (set it in ai-service/.env, then restart)"
            )
        elif not summary["gemini_api_key"]:
            logger.error(
                "GEMINI_API_KEY is not set: analysis is rejected with "
                "AI_PROVIDER_NOT_CONFIGURED (set it in ai-service/.env, then restart)"
            )
        try:
            yield
        finally:
            await app.state.provider.close()

    app = FastAPI(title="Recruiter AI Service", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.exception_handler(ServiceError)
    async def service_error(_request, error):
        body = {"error": {"code": error.code}}
        if error.retry_after_ms is not None:
            body["error"]["retryAfterMs"] = error.retry_after_ms
        return JSONResponse(body, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _error):
        return JSONResponse({"error": {"code": "AI_REQUEST_INVALID"}}, status_code=422)

    @app.exception_handler(Exception)
    async def internal_error(_request, _error):
        return JSONResponse({"error": {"code": "AI_SERVICE_INTERNAL_ERROR"}}, status_code=500)

    app.include_router(health_router)
    app.include_router(analysis_router)
    app.include_router(assessment_router)
    app.include_router(candidate_analysis_router)
    return app


app = create_app()
