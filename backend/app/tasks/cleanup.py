import asyncio

import redis.asyncio as redis


async def cleanup_stale_accounts(redis_client: redis.Redis):
    """Remove accounts from priority_index whose account key has expired."""
    while True:
        try:
            members = await redis_client.zrange("priority_index", 0, -1)
            for member_raw in members:
                username = member_raw.decode() if isinstance(member_raw, bytes) else member_raw
                exists = await redis_client.exists(f"account:{username}")
                if not exists:
                    await redis_client.zrem("priority_index", username)
        except Exception:
            pass
        await asyncio.sleep(900)  # Every 15 minutes
