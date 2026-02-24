import redis.asyncio as redis

from app.models import ScorePayload, AccountSummary, AccountDetail, ScoreDetail

TWENTY_FOUR_HOURS = 86400


class ScoreService:
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client

    async def ingest_score(self, payload: ScorePayload) -> None:
        username = payload.username
        ts = payload.timestamp

        score_key = f"score:{username}:{ts}"
        await self.redis.hset(score_key, mapping={
            "composite": payload.composite_score,
            "text": payload.text_score,
            "image": payload.image_score,
            "timestamp": ts,
        })
        await self.redis.expire(score_key, TWENTY_FOUR_HOURS)

        # Add score timestamp to account's score list (for history)
        scores_list_key = f"scores_list:{username}"
        await self.redis.zadd(scores_list_key, {str(ts): ts})
        await self.redis.expire(scores_list_key, TWENTY_FOUR_HOURS)

        # Update priority index (only if new score is higher)
        await self.redis.zadd(
            "priority_index",
            {username: payload.composite_score},
            gt=True,
        )

        # Update account summary for quick dashboard access
        account_key = f"account:{username}"
        await self.redis.hset(account_key, mapping={
            "username": username,
            "latest_composite": payload.composite_score,
            "latest_text": payload.text_score,
            "latest_image": payload.image_score,
            "last_seen": ts,
        })
        await self.redis.hincrby(account_key, "score_count", 1)
        await self.redis.expire(account_key, TWENTY_FOUR_HOURS)

        # Publish to Redis Stream for real-time SSE
        await self.redis.xadd("stream:scores", {
            "username": username,
            "composite": str(payload.composite_score),
            "text": str(payload.text_score),
            "image": str(payload.image_score),
            "timestamp": str(ts),
        }, maxlen=1000)

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

            summaries.append(AccountSummary(
                username=username,
                latest_composite=g("latest_composite"),
                max_composite=int(max_score),
                score_count=g("score_count"),
                latest_text_score=g("latest_text"),
                latest_image_score=g("latest_image"),
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

        # Get all score timestamps for this account
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

                scores.append(ScoreDetail(
                    composite=gs("composite"),
                    text_score=gs("text"),
                    image_score=gs("image"),
                    timestamp=gs("timestamp"),
                ))

        max_score = await self.redis.zscore("priority_index", username)

        return AccountDetail(
            username=username,
            latest_composite=g("latest_composite"),
            max_composite=int(max_score) if max_score else g("latest_composite"),
            score_count=g("score_count"),
            latest_text_score=g("latest_text"),
            latest_image_score=g("latest_image"),
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
