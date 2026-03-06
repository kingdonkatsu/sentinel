import asyncio
import json
from contextlib import asynccontextmanager

import redis.asyncio as redis
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.config import settings
from app.models import OutreachRequest, OutreachResponse, ScorePayload
from app.services.outreach_service import OutreachService
from app.services.score_service import ScoreService
from app.tasks.cleanup import cleanup_stale_accounts
from scripts.seed_demo import seed as seed_demo_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = redis.from_url(settings.REDIS_URL, decode_responses=False)
    cleanup_task = asyncio.create_task(cleanup_stale_accounts(app.state.redis))
    await seed_demo_data()
    yield
    cleanup_task.cancel()
    await app.state.redis.close()


app = FastAPI(title="Sentinel API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_redis(request: Request) -> redis.Redis:
    return request.app.state.redis


def verify_api_key(x_sentinel_key: str = Header(...)):
    if x_sentinel_key != settings.API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.post("/api/v1/scores")
async def submit_score(
    payload: ScorePayload,
    request: Request,
    x_sentinel_key: str = Header(...),
):
    verify_api_key(x_sentinel_key)
    service = ScoreService(get_redis(request))
    await service.ingest_score(payload)
    return {"status": "accepted"}


@app.get("/api/v1/dashboard")
async def get_dashboard(request: Request, limit: int = 50):
    service = ScoreService(get_redis(request))
    return await service.get_priority_dashboard(limit)


@app.get("/api/v1/dashboard/{username}")
async def get_account_detail(username: str, request: Request):
    service = ScoreService(get_redis(request))
    detail = await service.get_account_detail(username)
    if not detail:
        raise HTTPException(status_code=404, detail="Account not found")
    return detail


@app.get("/api/v1/scores/feed")
async def score_feed(request: Request):
    redis_client = get_redis(request)

    async def event_generator():
        last_id = "$"
        while True:
            try:
                entries = await redis_client.xread(
                    {"stream:scores": last_id}, block=5000, count=10
                )
                if entries:
                    for _stream_name, messages in entries:
                        for msg_id, data in messages:
                            last_id = msg_id
                            decoded = {
                                k.decode() if isinstance(k, bytes) else k:
                                v.decode() if isinstance(v, bytes) else v
                                for k, v in data.items()
                            }
                            yield f"data: {json.dumps(decoded)}\n\n"
                else:
                    yield ": keepalive\n\n"
            except asyncio.CancelledError:
                break
            except Exception:
                yield ": error\n\n"
                await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/v1/outreach/suggest", response_model=OutreachResponse)
async def suggest_outreach(request: OutreachRequest):
    service = OutreachService()
    return await service.generate(request)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "sentinel-api"}
