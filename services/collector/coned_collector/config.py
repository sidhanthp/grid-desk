from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    coned_email: str = ""
    coned_password: SecretStr = SecretStr("")
    coned_totp_secret: SecretStr = SecretStr("")
    coned_account_urn: str | None = None
    ingest_token: SecretStr = SecretStr("")
    session_encryption_key: SecretStr = SecretStr("")
    poll_seconds: int = Field(default=300, ge=60, le=3600)
    meter_key: str = "home"

    @property
    def ingestion_configured(self) -> bool:
        return bool(
            self.database_url
            and self.coned_email
            and self.coned_password.get_secret_value()
        )

settings = Settings()
