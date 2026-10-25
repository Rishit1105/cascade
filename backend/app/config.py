from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = BACKEND_DIR / "data"


class Settings(BaseSettings):
    """Process configuration. Runtime-tunable policy (auto-halt, risk model) lives in the DB."""

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="DAOGUARD_", extra="ignore")

    rpc_url: str = "http://127.0.0.1:8545"
    data_dir: Path = DEFAULT_DATA_DIR
    database_url: str | None = None

    anthropic_api_key: str | None = Field(
        default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "DAOGUARD_ANTHROPIC_API_KEY")
    )
    ai_model: str = "claude-opus-5-5"

    # Governance parameters for the local demo deployment (blocks, not seconds).
    review_window_blocks: int = 5
    voting_delay_blocks: int = 1
    voting_period_blocks: int = 24
    quorum_percent: int = 4

    sentinel_poll_seconds: float = 1.5
    sentinel_enabled: bool = True
    seed_on_empty_chain: bool = True

    cors_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'daoguard.db').as_posix()}"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.reports_dir.mkdir(parents=True, exist_ok=True)
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    return settings
