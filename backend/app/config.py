from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    REDIS_URL: str = "redis://redis:6379/0"
    API_KEY: str = "sentinel-hackathon-key"
    DASHBOARD_URL: str = "http://localhost:3000"
    OPENAI_API_KEY: str = ""
    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
