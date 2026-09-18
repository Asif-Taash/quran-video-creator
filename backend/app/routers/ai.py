import asyncio
import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from g4f.client import AsyncClient

logger = logging.getLogger(__name__)
router = APIRouter()

G4F_TIMEOUT_SECONDS = 20
POLLINATIONS_TIMEOUT_SECONDS = 20
POLLINATIONS_URL = "https://text.pollinations.ai/openai"
# 429 is deliberately excluded: the anonymous tier's rate limit window is
# 15s, so retrying immediately on 429 can't possibly succeed.
POLLINATIONS_RETRYABLE_STATUSES = {500, 502, 503, 504, 530}


class ChatRequest(BaseModel):
    system_prompt: str
    user_message: str


def _messages(system_prompt: str, user_message: str) -> list[dict]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]


async def _call_g4f(system_prompt: str, user_message: str) -> str:
    client = AsyncClient()
    response = await asyncio.wait_for(
        client.chat.completions.create(
            model="gpt-4o",  # g4f auto-routes to whichever free provider currently supports it
            messages=_messages(system_prompt, user_message),
        ),
        timeout=G4F_TIMEOUT_SECONDS,
    )
    content = response.choices[0].message.content
    if not content or not content.strip():
        raise ValueError("g4f returned empty content")
    return content


async def _call_pollinations(system_prompt: str, user_message: str) -> str:
    payload = {"model": "openai", "messages": _messages(system_prompt, user_message)}
    last_error: Exception | None = None

    # One retry only (not the frontend's 3-attempt consensus logic) -- this
    # layer just needs to smooth over a single transient Cloudflare/5xx
    # hiccup, the same class of error generate-background/route.ts already
    # retries on for the image endpoint on this same provider.
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=POLLINATIONS_TIMEOUT_SECONDS) as client:
                resp = await client.post(POLLINATIONS_URL, json=payload)
            if resp.status_code in POLLINATIONS_RETRYABLE_STATUSES and attempt == 0:
                await asyncio.sleep(1.5)
                continue
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            if not content or not content.strip():
                raise ValueError("Pollinations returned empty content")
            return content
        except Exception as e:
            last_error = e
            if attempt == 0:
                continue
            raise last_error

    raise last_error


@router.post("/chat")
async def chat_completion(request: ChatRequest):
    try:
        result = await _call_g4f(request.system_prompt, request.user_message)
        return {"result": result}
    except Exception as g4f_error:
        logger.warning("g4f chat failed, falling back to Pollinations: %s", g4f_error)
        try:
            result = await _call_pollinations(request.system_prompt, request.user_message)
            return {"result": result}
        except Exception as pollinations_error:
            logger.error("Pollinations fallback also failed: %s", pollinations_error)
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Both AI providers failed. g4f: {g4f_error}; "
                    f"pollinations: {pollinations_error}"
                ),
            )
