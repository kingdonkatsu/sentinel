import json
import logging
from dataclasses import dataclass
from typing import Literal

from openai import AsyncOpenAI

from app.config import settings
from app.models import OutreachRequest, OutreachResponse

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a specialist in youth mental health outreach for \
social workers in Singapore. You generate empathetic, culturally appropriate \
conversation starters for welfare check-ins.

RULES:
- You receive ONLY numerical risk scores (0-100), never actual content.
- Your suggestions are for the SOCIAL WORKER to use, not direct messages.
- Use trauma-informed language: warm, non-judgemental, strength-based.
- Avoid clinical or diagnostic language.
- Keep suggestions natural and conversational - as if casually checking in.
- Be culturally sensitive to Singapore's multi-ethnic youth context.
- Never reference "scores", "algorithms", or "monitoring" in suggestions.
- Provide 1 opening message and 2-3 follow-up prompts.
- Include a brief tone/approach note for the worker.

SCORE INTERPRETATION:
- Text Score: Higher = more negative/distressed language detected
- Image Score: Higher = darker/more concerning visual tone detected
- Composite: Weighted combination of both signals

Respond in this exact JSON format:
{
  "opening": "the opening message",
  "follow_ups": ["follow-up 1", "follow-up 2"],
  "tone_note": "guidance on tone and approach"
}"""


@dataclass
class OutreachGenerationResult:
    response: OutreachResponse
    provider: Literal["openai", "fallback"]


class OutreachService:
    def __init__(self):
        self.client = (
            AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            if settings.OPENAI_API_KEY
            else None
        )

    async def generate(self, request: OutreachRequest) -> OutreachResponse:
        result = await self.generate_with_provider(request)
        return result.response

    async def generate_with_provider(
        self, request: OutreachRequest
    ) -> OutreachGenerationResult:
        if not self.client:
            return OutreachGenerationResult(
                response=self._fallback_response(request),
                provider="fallback",
            )

        user_prompt = f"""Generate a check-in approach for a youth showing:
- Overall risk level: {request.composite_score}/100
- Emotional language indicator: {request.text_score}/100
- Visual tone indicator: {request.image_score}/100
{f'- Context: {request.context}' if request.context else ''}

Respond in JSON format with: opening, follow_ups (array), tone_note."""

        try:
            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.7,
                max_tokens=500,
            )

            text = response.choices[0].message.content.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

            data = json.loads(text)
            return OutreachGenerationResult(
                response=OutreachResponse(
                    opening=data.get(
                        "opening",
                        "Hey, just checking in - how are things going?",
                    ),
                    follow_ups=data.get(
                        "follow_ups", ["What's been on your mind lately?"]
                    ),
                    tone_note=data.get("tone_note", "Keep it warm and casual."),
                ),
                provider="openai",
            )
        except Exception:
            logger.exception(
                "OpenAI outreach generation failed; falling back to canned response"
            )
            return OutreachGenerationResult(
                response=self._fallback_response(request),
                provider="fallback",
            )

    def _fallback_response(self, request: OutreachRequest) -> OutreachResponse:
        if request.composite_score >= 85:
            return OutreachResponse(
                opening=(
                    "Hey, I've been thinking about you. "
                    "How are you doing today - honestly?"
                ),
                follow_ups=[
                    "I'm here if you ever want to talk, no pressure at all.",
                    "Is there anything going on that's been weighing on you?",
                    "Sometimes it helps just to have someone listen - I'm around.",
                ],
                tone_note=(
                    "Approach with gentle urgency. Be direct but warm. Avoid being "
                    "preachy. Let them know you genuinely care and are available."
                ),
            )
        if request.composite_score >= 70:
            return OutreachResponse(
                opening="Hey! Haven't caught up in a while - how's everything going?",
                follow_ups=[
                    "What's been keeping you busy this week?",
                    "Anything new or exciting happening?",
                    "How are things at home/school?",
                ],
                tone_note=(
                    "Keep it light and conversational. Show genuine interest without "
                    "seeming investigative. Let the conversation flow naturally."
                ),
            )
        return OutreachResponse(
            opening="Hi! Just wanted to say hey - how's your week been?",
            follow_ups=[
                "Done anything fun recently?",
                "How are things going with your friends?",
            ],
            tone_note=(
                "Casual and friendly. This is a routine check-in to maintain rapport "
                "and trust."
            ),
        )
