"""Integration tests for Sentinel API routes backed by Redis."""

import asyncio
import json
from types import SimpleNamespace

import pytest
import redis.asyncio as redis
from fastapi.testclient import TestClient

from app import main as main_module
from app.models import ScorePayload
from app.services.score_service import ScoreService
from app.services import outreach_service as outreach_module

TEST_REDIS_URL = "redis://localhost:6379/15"
VALID_HEADERS = {"X-Sentinel-Key": "sentinel-hackathon-key"}


def make_score_payload(
    username: str = "test_user_123",
    *,
    composite_score: int = 75,
    text_score: int | None = 80,
    image_score: int | None = 70,
    timestamp: int = 1700000000000,
    modality_scores: dict[str, int] | None = None,
) -> dict:
    payload = {
        "username": username,
        "composite_score": composite_score,
        "timestamp": timestamp,
    }
    payload["text_score"] = text_score
    payload["image_score"] = image_score
    if modality_scores is not None:
        payload["modality_scores"] = modality_scores
    return payload


async def flush_test_redis() -> None:
    redis_client = redis.from_url(TEST_REDIS_URL, decode_responses=False)
    try:
        await redis_client.flushdb()
    finally:
        await redis_client.aclose()


async def ensure_test_redis_async() -> None:
    redis_client = redis.from_url(TEST_REDIS_URL, decode_responses=False)
    try:
        await redis_client.ping()
    finally:
        await redis_client.aclose()


def ensure_test_redis() -> None:
    try:
        asyncio.run(ensure_test_redis_async())
    except Exception as exc:  # pragma: no cover - environment-dependent guard
        pytest.skip(f"Local Redis is required for backend integration tests: {exc}")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    ensure_test_redis()
    monkeypatch.setattr(main_module.settings, "REDIS_URL", TEST_REDIS_URL)
    monkeypatch.setattr(outreach_module.settings, "OPENAI_API_KEY", "")
    asyncio.run(flush_test_redis())
    with TestClient(main_module.app) as test_client:
        yield test_client
    asyncio.run(flush_test_redis())


def submit_score(client: TestClient, **kwargs):
    payload = make_score_payload(**kwargs)
    return client.post("/api/v1/scores", json=payload, headers=VALID_HEADERS)


def test_health(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "sentinel-api"}


def test_submit_score_requires_api_key(client: TestClient):
    response = client.post("/api/v1/scores", json=make_score_payload())
    assert response.status_code == 422


def test_submit_score_rejects_invalid_key(client: TestClient):
    response = client.post(
        "/api/v1/scores",
        json=make_score_payload(),
        headers={"X-Sentinel-Key": "wrong-key"},
    )
    assert response.status_code == 401


def test_submit_score_validates_empty_username(client: TestClient):
    response = client.post(
        "/api/v1/scores",
        json=make_score_payload(username=""),
        headers=VALID_HEADERS,
    )
    assert response.status_code == 422


def test_submit_score_validates_score_range(client: TestClient):
    response = client.post(
        "/api/v1/scores",
        json=make_score_payload(composite_score=150),
        headers=VALID_HEADERS,
    )
    assert response.status_code == 422


def test_dashboard_returns_ingested_account(client: TestClient):
    submit_response = submit_score(
        client,
        username="dashboard_user",
        composite_score=86,
        text_score=90,
        image_score=80,
        modality_scores={"text": 92, "visual": 75, "temporal": 70},
    )
    assert submit_response.status_code == 200

    response = client.get("/api/v1/dashboard")
    assert response.status_code == 200

    data = response.json()
    assert len(data) == 1
    assert data[0]["username"] == "dashboard_user"
    assert data[0]["latest_composite"] == 86
    assert data[0]["score_count"] == 1


def test_account_detail_returns_score_history(client: TestClient):
    submit_score(
        client,
        username="detail_user",
        composite_score=88,
        text_score=85,
        image_score=82,
        timestamp=1700000000001,
    )
    submit_score(
        client,
        username="detail_user",
        composite_score=91,
        text_score=92,
        image_score=89,
        timestamp=1700000000002,
    )

    response = client.get("/api/v1/dashboard/detail_user")
    assert response.status_code == 200

    data = response.json()
    assert data["username"] == "detail_user"
    assert data["score_count"] == 2
    assert data["max_composite"] == 91
    assert [score["timestamp"] for score in data["scores"]] == [
        1700000000001,
        1700000000002,
    ]


def test_account_detail_not_found(client: TestClient):
    response = client.get("/api/v1/dashboard/nonexistent_user")
    assert response.status_code == 404


def test_dashboard_and_detail_preserve_missing_modality_scores(client: TestClient):
    submit_score(
        client,
        username="missing_scores_user",
        composite_score=80,
        text_score=84,
        image_score=76,
        timestamp=1700000000100,
    )
    submit_score(
        client,
        username="missing_scores_user",
        composite_score=68,
        text_score=None,
        image_score=None,
        timestamp=1700000000200,
        modality_scores={"temporal": 63, "metadata": 58},
    )

    dashboard_response = client.get("/api/v1/dashboard")
    assert dashboard_response.status_code == 200
    dashboard_entry = dashboard_response.json()[0]
    assert dashboard_entry["latest_text_score"] is None
    assert dashboard_entry["latest_image_score"] is None

    detail_response = client.get("/api/v1/dashboard/missing_scores_user")
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["latest_text_score"] is None
    assert detail["latest_image_score"] is None
    assert detail["scores"][-1]["text_score"] is None
    assert detail["scores"][-1]["image_score"] is None


def test_confirm_case_and_get_confirmations(client: TestClient):
    submit_score(
        client,
        username="confirmed_user",
        composite_score=86,
        text_score=90,
        image_score=80,
        modality_scores={"text": 92, "visual": 75, "temporal": 70},
    )

    confirm_response = client.post(
        "/api/v1/accounts/confirmed_user/confirm",
        headers=VALID_HEADERS,
    )
    assert confirm_response.status_code == 200
    assert confirm_response.json() == {"status": "confirmed"}

    confirmations_response = client.get(
        "/api/v1/confirmations?since=0",
        headers=VALID_HEADERS,
    )
    assert confirmations_response.status_code == 200

    confirmations = confirmations_response.json()
    assert len(confirmations) == 1
    assert confirmations[0]["username"] == "confirmed_user"
    assert confirmations[0]["modality_scores"] == {
        "text": 92,
        "visual": 75,
        "temporal": 70,
    }


@pytest.mark.asyncio
async def test_score_feed_streams_submitted_scores(monkeypatch: pytest.MonkeyPatch):
    try:
        await ensure_test_redis_async()
    except Exception as exc:  # pragma: no cover - environment-dependent guard
        pytest.skip(f"Local Redis is required for backend integration tests: {exc}")
    monkeypatch.setattr(main_module.settings, "REDIS_URL", TEST_REDIS_URL)
    await flush_test_redis()

    redis_client = redis.from_url(TEST_REDIS_URL, decode_responses=False)
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(redis=redis_client))
    )
    response = await main_module.score_feed(request)

    async def ingest() -> None:
        await asyncio.sleep(0.1)
        service = ScoreService(redis_client)
        await service.ingest_score(
            ScorePayload(
                username="feed_user",
                composite_score=83,
                text_score=79,
                image_score=76,
                timestamp=1700000000003,
            )
        )

    ingest_task = asyncio.create_task(ingest())

    try:
        assert response.media_type == "text/event-stream"
        chunk = await asyncio.wait_for(anext(response.body_iterator), timeout=6)
        if isinstance(chunk, bytes):
            chunk = chunk.decode()
        assert chunk == (
            'data: {"username": "feed_user", "composite": "83", "text": "79", '
            '"image": "76", "timestamp": "1700000000003"}\n\n'
        )
    finally:
        await ingest_task
        await response.body_iterator.aclose()
        await redis_client.aclose()
        await flush_test_redis()


def test_outreach_suggest_returns_fallback_when_key_missing(client: TestClient):
    response = client.post(
        "/api/v1/outreach/suggest",
        json={
            "composite_score": 85,
            "text_score": 80,
            "image_score": 90,
        },
    )
    assert response.status_code == 200
    assert response.headers["x-sentinel-outreach-provider"] == "fallback"
    assert response.json()["opening"] == (
        "Hey, I've been thinking about you. How are you doing today - honestly?"
    )


def test_outreach_suggest_returns_openai_provider_on_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    class FakeCompletions:
        async def create(self, **_kwargs):
            return type(
                "FakeResponse",
                (),
                {
                    "choices": [
                        type(
                            "FakeChoice",
                            (),
                            {
                                "message": type(
                                    "FakeMessage",
                                    (),
                                    {
                                        "content": json.dumps(
                                            {
                                                "opening": "Hello there",
                                                "follow_ups": [
                                                    "How have you been?",
                                                    "Want to talk?",
                                                ],
                                                "tone_note": "Warm and calm.",
                                            }
                                        )
                                    },
                                )()
                            },
                        )()
                    ]
                },
            )()

    class FakeClient:
        def __init__(self, **_kwargs):
            self.chat = type(
                "FakeChat", (), {"completions": FakeCompletions()}
            )()

    monkeypatch.setattr(outreach_module.settings, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(outreach_module, "AsyncOpenAI", FakeClient)

    response = client.post(
        "/api/v1/outreach/suggest",
        json={
            "composite_score": 72,
            "text_score": 68,
            "image_score": 75,
            "context": "late-night posts",
        },
    )
    assert response.status_code == 200
    assert response.headers["x-sentinel-outreach-provider"] == "openai"
    assert response.json() == {
        "opening": "Hello there",
        "follow_ups": ["How have you been?", "Want to talk?"],
        "tone_note": "Warm and calm.",
    }


def test_outreach_suggest_logs_and_falls_back_on_openai_error(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    class FailingCompletions:
        async def create(self, **_kwargs):
            raise RuntimeError("boom")

    class FailingClient:
        def __init__(self, **_kwargs):
            self.chat = type(
                "FakeChat", (), {"completions": FailingCompletions()}
            )()

    monkeypatch.setattr(outreach_module.settings, "OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(outreach_module, "AsyncOpenAI", FailingClient)

    with caplog.at_level("ERROR", logger=outreach_module.__name__):
        response = client.post(
            "/api/v1/outreach/suggest",
            json={
                "composite_score": 85,
                "text_score": 80,
                "image_score": 90,
            },
        )

    assert response.status_code == 200
    assert response.headers["x-sentinel-outreach-provider"] == "fallback"
    assert "OpenAI outreach generation failed" in caplog.text
