import json
import time

import redis.asyncio as redis

from app.models import (
    AccountDetail,
    AccountSummary,
    ConfirmationEntry,
    ScoreDetail,
    ScorePayload,
)

TWENTY_FOUR_HOURS = 86400


class ScoreService:
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client

    async def ingest_score(self, payload: ScorePayload) -> None:
        username = payload.username
        ts = payload.timestamp

        score_key = f"score:{username}:{ts}"
        mapping: dict = {
            "composite": payload.composite_score,
            "timestamp": ts,
        }
        if payload.text_score is not None:
            mapping["text"] = payload.text_score
        if payload.image_score is not None:
            mapping["image"] = payload.image_score
        if payload.modality_scores:
            mapping["modality_scores"] = json.dumps(payload.modality_scores)

        await self.redis.hset(score_key, mapping=mapping)
        await self.redis.expire(score_key, TWENTY_FOUR_HOURS)

        scores_list_key = f"scores_list:{username}"
        await self.redis.zadd(scores_list_key, {str(ts): ts})
        await self.redis.expire(scores_list_key, TWENTY_FOUR_HOURS)

        await self.redis.zadd(
            "priority_index",
            {username: payload.composite_score},
            gt=True,
        )

        account_key = f"account:{username}"
        account_mapping: dict = {
            "username": username,
            "latest_composite": payload.composite_score,
            "last_seen": ts,
        }
        if payload.text_score is not None:
            account_mapping["latest_text"] = payload.text_score
        if payload.image_score is not None:
            account_mapping["latest_image"] = payload.image_score
        if payload.modality_scores:
            account_mapping["latest_modality_scores"] = json.dumps(payload.modality_scores)

        await self.redis.hset(account_key, mapping=account_mapping)
        if payload.text_score is None:
            await self.redis.hdel(account_key, "latest_text")
        if payload.image_score is None:
            await self.redis.hdel(account_key, "latest_image")
        await self.redis.hincrby(account_key, "score_count", 1)
        await self.redis.expire(account_key, TWENTY_FOUR_HOURS)

        stream_payload = {
            "username": username,
            "composite": str(payload.composite_score),
        }
        if payload.text_score is not None:
            stream_payload["text"] = str(payload.text_score)
        if payload.image_score is not None:
            stream_payload["image"] = str(payload.image_score)
        stream_payload["timestamp"] = str(ts)

        await self.redis.xadd("stream:scores", stream_payload, maxlen=1000)

    async def confirm_case(self, username: str) -> None:
        """Record a social worker confirmation for calibration feedback."""
        account_key = f"account:{username}"
        data = await self.redis.hgetall(account_key)
        if not data:
            return

        modality_raw = data.get(b"latest_modality_scores", data.get("latest_modality_scores", "{}"))
        if isinstance(modality_raw, bytes):
            modality_raw = modality_raw.decode()
        modality_scores: dict[str, int] = json.loads(modality_raw or "{}")

        ts = int(time.time() * 1000)
        confirmation_key = f"confirmation:{username}:{ts}"
        await self.redis.hset(confirmation_key, mapping={
            "username": username,
            "modality_scores": json.dumps(modality_scores),
            "timestamp": ts,
        })
        await self.redis.expire(confirmation_key, TWENTY_FOUR_HOURS)

        # Index confirmations by timestamp for efficient range queries
        await self.redis.zadd("confirmations", {f"{username}:{ts}": ts})
        await self.redis.expire("confirmations", TWENTY_FOUR_HOURS)

    async def get_confirmations(self, since_ts: int) -> list[ConfirmationEntry]:
        """Return all confirmations recorded after since_ts (ms epoch)."""
        keys_raw = await self.redis.zrangebyscore("confirmations", since_ts + 1, "+inf")
        results: list[ConfirmationEntry] = []

        for key_raw in keys_raw:
            key_str = key_raw.decode() if isinstance(key_raw, bytes) else key_raw
            confirmation_key = f"confirmation:{key_str}"
            data = await self.redis.hgetall(confirmation_key)
            if not data:
                continue

            username_raw = data.get(b"username", data.get("username", b""))
            modality_raw = data.get(b"modality_scores", data.get("modality_scores", b"{}"))
            ts_raw = data.get(b"timestamp", data.get("timestamp", b"0"))

            uname = username_raw.decode() if isinstance(username_raw, bytes) else username_raw
            modality_str = modality_raw.decode() if isinstance(modality_raw, bytes) else modality_raw
            ts = int(ts_raw.decode() if isinstance(ts_raw, bytes) else ts_raw)

            results.append(ConfirmationEntry(
                username=uname,
                modality_scores=json.loads(modality_str or "{}"),
                timestamp=ts,
            ))

        return results

    async def get_priority_dashboard(self, limit: int = 50) -> list[AccountSummary]:
        members_with_scores = await self.redis.zrevrange(
            "priority_index", 0, limit - 1, withscores=True
        )

        summaries = []
        for member_raw, max_score in members_with_scores:
            username = member_raw.decode() if isinstance(member_raw, bytes) else member_raw
            account_key = f"account:{username}"
            data = await self.redis.hgetall(account_key)

            if not data:
                continue

            def g(key: str) -> int:
                val = data.get(key.encode() if isinstance(member_raw, bytes) else key, 0)
                return int(val)

            def g_optional(key: str) -> int | None:
                val = data.get(key.encode() if isinstance(member_raw, bytes) else key)
                if val is None:
                    return None
                return int(val)

            summaries.append(AccountSummary(
                username=username,
                latest_composite=g("latest_composite"),
                max_composite=int(max_score),
                score_count=g("score_count"),
                latest_text_score=g_optional("latest_text"),
                latest_image_score=g_optional("latest_image"),
                last_seen=g("last_seen"),
                trend=await self._compute_trend(username),
            ))

        return summaries

    async def get_account_detail(self, username: str) -> AccountDetail | None:
        account_key = f"account:{username}"
        data = await self.redis.hgetall(account_key)

        if not data:
            return None

        def g(key: str) -> int:
            val = data.get(key.encode(), data.get(key, 0))
            return int(val)

        def g_optional(key: str) -> int | None:
            val = data.get(key.encode(), data.get(key))
            if val is None:
                return None
            return int(val)

        scores_list_key = f"scores_list:{username}"
        timestamps = await self.redis.zrange(scores_list_key, 0, -1)

        scores = []
        for ts_raw in timestamps:
            ts_str = ts_raw.decode() if isinstance(ts_raw, bytes) else ts_raw
            score_key = f"score:{username}:{ts_str}"
            score_data = await self.redis.hgetall(score_key)
            if score_data:
                def gs(key: str) -> int:
                    val = score_data.get(key.encode(), score_data.get(key, 0))
                    return int(val)

                def gs_optional(key: str) -> int | None:
                    val = score_data.get(key.encode(), score_data.get(key))
                    if val is None:
                        return None
                    return int(val)

                scores.append(ScoreDetail(
                    composite=gs("composite"),
                    text_score=gs_optional("text"),
                    image_score=gs_optional("image"),
                    timestamp=gs("timestamp"),
                ))

        max_score = await self.redis.zscore("priority_index", username)

        return AccountDetail(
            username=username,
            latest_composite=g("latest_composite"),
            max_composite=int(max_score) if max_score else g("latest_composite"),
            score_count=g("score_count"),
            latest_text_score=g_optional("latest_text"),
            latest_image_score=g_optional("latest_image"),
            last_seen=g("last_seen"),
            trend=await self._compute_trend(username),
            scores=scores,
        )

    async def _compute_trend(self, username: str) -> str:
        scores_list_key = f"scores_list:{username}"
        timestamps = await self.redis.zrange(scores_list_key, -3, -1)

        if len(timestamps) < 2:
            return "stable"

        composites = []
        for ts_raw in timestamps:
            ts_str = ts_raw.decode() if isinstance(ts_raw, bytes) else ts_raw
            score_key = f"score:{username}:{ts_str}"
            val = await self.redis.hget(score_key, "composite")
            if val:
                composites.append(int(val))

        if len(composites) < 2:
            return "stable"

        diff = composites[-1] - composites[0]
        if diff > 5:
            return "rising"
        elif diff < -5:
            return "declining"
        return "stable"
