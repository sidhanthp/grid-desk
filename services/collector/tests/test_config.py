from coned_collector.config import Settings


def test_server_login_can_be_configured_without_totp() -> None:
    settings = Settings(
        database_url="postgresql://example",
        coned_email="person@example.com",
        coned_password="password",
        coned_totp_secret="",
    )

    assert settings.ingestion_configured
