"""
Seed Redis with realistic demo data for Sentinel hackathon demo.

Usage:
    python -m scripts.seed_demo
    # or from backend directory:
    REDIS_URL=redis://localhost:6379/0 python scripts/seed_demo.py
"""

import asyncio
import os
import random
import time

import redis.asyncio as aioredis

TWENTY_FOUR_HOURS = 86400

# Simulated accounts with realistic Instagram usernames and varying risk profiles
DEMO_ACCOUNTS = [
    {
        "username": "aisyah.r_03",
        "scores": [(92, 88, 95), (85, 90, 80), (78, 82, 74)],
    },
    {
        "username": "wei_jie_2010",
        "scores": [(87, 78, 93), (82, 75, 88)],
    },
    {
        "username": "priya.k.sg",
        "scores": [(45, 40, 50), (58, 55, 60), (72, 68, 75), (80, 76, 83)],
    },
    {
        "username": "haziq_m14",
        "scores": [(68, 72, 64), (65, 70, 60)],
    },
    {
        "username": "siti.nurhaliza05",
        "scores": [(62, 55, 68)],
    },
    {
        "username": "jx.lim_",
        "scores": [(78, 80, 75), (60, 55, 65), (45, 40, 50)],
    },
    {
        "username": "ravi.s.2009",
        "scores": [(35, 30, 40), (32, 28, 36)],
    },
    {
        "username": "nurul_iman22",
        "scores": [(28, 25, 30)],
    },
    {
        "username": "marcus.t_sg",
        "scores": [(55, 60, 50), (58, 65, 52)],
    },
    {
        "username": "zhi_xuan.c",
        "scores": [(83, 85, 80), (88, 92, 84), (91, 95, 87)],
    },
    {
        "username": "farah.d_15",
        "scores": [(60, 58, 62)],
    },
    {
        "username": "jun.kai_04",
        "scores": [(22, 20, 25), (25, 22, 28)],
    },
]


async def seed():
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    r = aioredis.from_url(redis_url, decode_responses=False)

    # Clear existing demo data
    await r.delete("priority_index")

    now_ms = int(time.time() * 1000)
    seeded = 0

    for account_data in DEMO_ACCOUNTS:
        username = account_data["username"]
        scores = account_data["scores"]
        max_composite = 0

        for i, (composite, text, image) in enumerate(scores):
            # Space scores 1-4 hours apart, most recent first
            ts = now_ms - (len(scores) - 1 - i) * 3600 * 1000 + random.randint(0, 60000)

            score_key = f"score:{username}:{ts}"
            await r.hset(score_key, mapping={
                "composite": composite,
                "text": text,
                "image": image,
                "timestamp": ts,
            })
            await r.expire(score_key, TWENTY_FOUR_HOURS)

            # Add to score list
            scores_list_key = f"scores_list:{username}"
            await r.zadd(scores_list_key, {str(ts): ts})
            await r.expire(scores_list_key, TWENTY_FOUR_HOURS)

            max_composite = max(max_composite, composite)

        # Set account summary
        latest = scores[-1]
        account_key = f"account:{username}"
        await r.hset(account_key, mapping={
            "username": username,
            "latest_composite": latest[0],
            "latest_text": latest[1],
            "latest_image": latest[2],
            "last_seen": now_ms - random.randint(0, 7200000),
            "score_count": len(scores),
        })
        await r.expire(account_key, TWENTY_FOUR_HOURS)

        # Add to priority index
        await r.zadd("priority_index", {username: max_composite})

        seeded += 1

    await r.close()
    print(f"Seeded {seeded} demo accounts into Redis")
    print(f"Dashboard URL: http://localhost:3000/dashboard")


if __name__ == "__main__":
    asyncio.run(seed())
