from pydantic import BaseModel, Field
from typing import Optional


class ScorePayload(BaseModel):
    """Incoming score from extension. Contains only scores + username.
    No story content (images, text, video) is ever transmitted."""
    username: str = Field(..., min_length=1, max_length=100)
    composite_score: int = Field(..., ge=0, le=100)
    text_score: Optional[int] = Field(None, ge=0, le=100)
    image_score: Optional[int] = Field(None, ge=0, le=100)
    timestamp: int
    # Optional per-modality scores from the multi-modal pipeline
    modality_scores: Optional[dict[str, int]] = None


class ConfirmationEntry(BaseModel):
    """A confirmed case — recorded when a social worker acts on a flagged account."""
    username: str
    modality_scores: dict[str, int]
    timestamp: int


class AccountSummary(BaseModel):
    """Dashboard view of a single monitored account."""
    username: str
    latest_composite: int
    max_composite: int
    score_count: int
    latest_text_score: Optional[int]
    latest_image_score: Optional[int]
    last_seen: int
    trend: str


class ScoreDetail(BaseModel):
    """Individual score entry for account detail view."""
    composite: int
    text_score: Optional[int]
    image_score: Optional[int]
    timestamp: int


class AccountDetail(BaseModel):
    """Full detail view for a single account."""
    username: str
    latest_composite: int
    max_composite: int
    score_count: int
    latest_text_score: Optional[int]
    latest_image_score: Optional[int]
    last_seen: int
    trend: str
    scores: list[ScoreDetail]


class OutreachRequest(BaseModel):
    """Request for AI conversation starter."""
    composite_score: int = Field(..., ge=0, le=100)
    text_score: int = Field(..., ge=0, le=100)
    image_score: int = Field(..., ge=0, le=100)
    context: Optional[str] = None


class OutreachResponse(BaseModel):
    """AI-generated conversation starter."""
    opening: str
    follow_ups: list[str]
    tone_note: str
