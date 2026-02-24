"""Basic tests for the Sentinel API score endpoints."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

VALID_PAYLOAD = {
    "username": "test_user_123",
    "composite_score": 75,
    "text_score": 80,
    "image_score": 70,
    "timestamp": 1700000000000,
}


def test_health():
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_submit_score_requires_api_key():
    response = client.post("/api/v1/scores", json=VALID_PAYLOAD)
    assert response.status_code == 422  # Missing header


def test_submit_score_rejects_invalid_key():
    response = client.post(
        "/api/v1/scores",
        json=VALID_PAYLOAD,
        headers={"X-Sentinel-Key": "wrong-key"},
    )
    assert response.status_code == 401


def test_submit_score_validates_empty_username():
    bad_payload = {**VALID_PAYLOAD, "username": ""}
    response = client.post(
        "/api/v1/scores",
        json=bad_payload,
        headers={"X-Sentinel-Key": "sentinel-hackathon-key"},
    )
    assert response.status_code == 422


def test_submit_score_validates_score_range():
    bad_payload = {**VALID_PAYLOAD, "composite_score": 150}
    response = client.post(
        "/api/v1/scores",
        json=bad_payload,
        headers={"X-Sentinel-Key": "sentinel-hackathon-key"},
    )
    assert response.status_code == 422


def test_dashboard_returns_list():
    response = client.get("/api/v1/dashboard")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_account_detail_not_found():
    response = client.get("/api/v1/dashboard/nonexistent_user")
    assert response.status_code == 404


def test_outreach_suggest():
    response = client.post(
        "/api/v1/outreach/suggest",
        json={
            "composite_score": 85,
            "text_score": 80,
            "image_score": 90,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert "opening" in data
    assert "follow_ups" in data
    assert "tone_note" in data
