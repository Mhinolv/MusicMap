"""Signed-in map session history (#77): the last 5 maps per account in the user store.

Keys hold one JSON document each:
- `tunegraph:history:{sub}`: the index, `{"sessions": [meta, ...]}` newest first.
- `tunegraph:history:{sub}:{id}`: one session with its map snapshot.

The map is the frontend's `tunegraph:map:v1` JSON text, kept as a string so the
browser can reuse `decodeMap`. One key per session keeps every write under 1 MB.
"""

from __future__ import annotations

import json
import time
from typing import Any

from app.services.user_store import UserStore

HISTORY_PREFIX = "tunegraph:history:"
HISTORY_LIMIT = 5
# Same limits as frontend/src/graph/mapSnapshot.ts.
MAP_NODE_LIMIT = 500
MAP_BYTE_LIMIT = 1024 * 1024
META_FIELDS = ("id", "seed", "mode", "stops", "updated_at")


class MapTooLarge(ValueError):
    pass


class BadMap(ValueError):
    pass


def check_map(raw: str) -> None:
    """Reject oversize or structurally wrong snapshots. The browser checks topology on restore."""
    if len(raw) > MAP_BYTE_LIMIT or len(raw.encode()) > MAP_BYTE_LIMIT:
        raise MapTooLarge("map is over the 1 MB limit")
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise BadMap("map is not JSON") from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise BadMap("map version is not 1")
    nodes, edges, root = value.get("nodes"), value.get("edges"), value.get("rootId")
    if not isinstance(nodes, list) or not nodes or not isinstance(edges, list):
        raise BadMap("map needs nodes and edges")
    if len(nodes) > MAP_NODE_LIMIT:
        raise MapTooLarge("map is over the 500 node limit")
    if not isinstance(root, str) or not root.strip():
        raise BadMap("map needs a rootId")
    if not any(isinstance(n, dict) and n.get("id") == root for n in nodes):
        raise BadMap("map rootId is not a node")


def _index_key(sub: str) -> str:
    return f"{HISTORY_PREFIX}{sub}"


def _session_key(sub: str, sid: str) -> str:
    return f"{HISTORY_PREFIX}{sub}:{sid}"


def _meta(session: dict[str, Any]) -> dict[str, Any]:
    return {k: session[k] for k in META_FIELDS}


async def list_sessions(store: UserStore, sub: str) -> list[dict[str, Any]]:
    index = await store.get(_index_key(sub)) or {}
    sessions = [s for s in index.get("sessions", []) if isinstance(s, dict) and all(k in s for k in META_FIELDS)]
    return sorted(sessions, key=lambda s: s["updated_at"], reverse=True)[:HISTORY_LIMIT]


async def get_session(store: UserStore, sub: str, sid: str) -> dict[str, Any] | None:
    if not any(s["id"] == sid for s in await list_sessions(store, sub)):
        return None
    return await store.get(_session_key(sub, sid))


async def save_session(store: UserStore, sub: str, session: dict[str, Any]) -> list[dict[str, Any]]:
    """Create or update one session, then keep the newest 5. Future times clamp to now."""
    session = {**session, "updated_at": min(int(session["updated_at"]), int(time.time() * 1000))}
    current = [s for s in await list_sessions(store, sub) if s["id"] != session["id"]]
    ranked = sorted([*current, _meta(session)], key=lambda s: s["updated_at"], reverse=True)
    kept, dropped = ranked[:HISTORY_LIMIT], ranked[HISTORY_LIMIT:]
    if any(s["id"] == session["id"] for s in kept):
        await store.set(_session_key(sub, session["id"]), session)
    await store.set(_index_key(sub), {"sessions": kept})
    for old in dropped:
        if old["id"] != session["id"]:
            await store.delete(_session_key(sub, old["id"]))
    return kept


async def delete_session(store: UserStore, sub: str, sid: str) -> list[dict[str, Any]]:
    kept = [s for s in await list_sessions(store, sub) if s["id"] != sid]
    await store.set(_index_key(sub), {"sessions": kept})
    await store.delete(_session_key(sub, sid))
    return kept


async def clear_sessions(store: UserStore, sub: str) -> None:
    for old in await list_sessions(store, sub):
        await store.delete(_session_key(sub, old["id"]))
    await store.delete(_index_key(sub))
