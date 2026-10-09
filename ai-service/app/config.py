from pathlib import Path
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        extra="ignore", hide_input_in_errors=True,
    )
    ai_service_api_key: SecretStr = SecretStr("")
    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = Field(default="gemini-flash-lite-latest", min_length=1, max_length=200)
    gemini_request_timeout_ms: int = Field(default=25000, ge=100, le=120000)

    def safe_summary(self) -> dict[str, bool]:
        """Configuration validation summary — booleans only.

        Safe to log: never a key, a prefix of one, or even its length. The two
        entries are reported separately because they fail differently and are
        fixed in the same place (ai-service/.env):

          * ai_service_api_key — when absent, every worker call is rejected with
            503 AI_SERVICE_NOT_CONFIGURED before any work happens;
          * gemini_api_key — when absent, the provider reports
            AI_PROVIDER_NOT_CONFIGURED instead of calling the model.
        """
        return {
            "ai_service_api_key": bool(self.ai_service_api_key.get_secret_value().strip()),
            "gemini_api_key": bool(self.gemini_api_key.get_secret_value().strip()),
        }
