import secrets
from fastapi import Request
from app.errors import ServiceError


def authenticate(request: Request):
    expected = request.app.state.settings.ai_service_api_key.get_secret_value()
    if not expected.strip():
        raise ServiceError("AI_SERVICE_NOT_CONFIGURED", 503)
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token or not secrets.compare_digest(token.encode(), expected.encode()):
        raise ServiceError("AI_SERVICE_UNAUTHORIZED", 401)
