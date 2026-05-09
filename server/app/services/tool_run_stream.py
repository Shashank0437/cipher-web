"""Consume Redis Stream chunks emitted by the agent during tool execution."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

import redis.asyncio as redis_async

logger = logging.getLogger(__name__)

TOOL_RUN_STREAM_PREFIX = "cipherstrike:toolrun:"


async def drain_tool_run_stream(
    client: redis_async.Redis,
    stream_run_id: str,
    runner_task: asyncio.Task[Any],
    *,
    on_chunk: Callable[[dict[str, Any]], Awaitable[None]],
) -> None:
    """
    Read stream entries until ``runner_task`` completes and the stream goes idle.

    Ignores malformed entries; forwards decoded JSON dicts to ``on_chunk``.
    """
    key = TOOL_RUN_STREAM_PREFIX + stream_run_id
    last_id = "0-0"
    idle_after_done = 0

    while True:
        runner_done = runner_task.done()
        block_ms = 150 if not runner_done else 40
        try:
            blocks = await client.xread({key: last_id}, count=120, block=block_ms)
        except Exception as exc:  # pragma: no cover
            logger.warning("tool_run_stream XREAD failed: %s", exc)
            await asyncio.sleep(0.15)
            blocks = []

        if blocks:
            idle_after_done = 0
            for _sk, entries in blocks:
                for eid, fields in entries:
                    last_id = eid
                    raw = fields.get("d")
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", errors="replace")
                    if not isinstance(raw, str) or not raw.strip():
                        continue
                    try:
                        evt = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(evt, dict):
                        await on_chunk(evt)
        elif runner_done:
            idle_after_done += 1
            if idle_after_done >= 12:
                break
        else:
            idle_after_done = 0
