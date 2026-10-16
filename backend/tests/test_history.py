"""Map session history API (#77): auth, list order, the cap of 5 and payload checks. No live calls."""

from __future__ import annotations

import json
import time

import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings
from app.services import user_store
from app.services.map_history import HISTORY_PREFIX, MAP_BYTE_LIMIT, MAP_NODE_LIMIT


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for name in ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN",
                 "SESSION_SECRET", "GOOGLE_CLIENT_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()
    yield
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()


@pytest.fixture
async def client():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _sign_in(client) -> None:
    assert (await client.post("/api/auth/mock")).status_code == 200


def snapshot(root="radiohead", count=2) -> str:
    nodes = [{"id": root, "name": "Radiohead", "kind": "artist"}]
    nodes += [{"id": f"n{i}", "name": f"Node {i}", "kind": "artist", "parentId": root} for i in range(1, count)]
    return json.dumps({"version": 1, "rootId": root, "journey": [root], "nodes": nodes, "edges": []})


def body(updated_at: int, **overrides) -> dict:
    return {"seed": "Radiohead", "mode": "artist", "stops": 1, "updated_at": updated_at, "map": snapshot(), **overrides}


NOW = int(time.time() * 1000)


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/history"), ("GET", "/api/history/s1"), ("PUT", "/api/history/s1"),
    ("DELETE", "/api/history/s1"), ("DELETE", "/api/history"),
])
async def test_every_route_needs_sign_in(client, method, path):
    r = await client.request(method, path, json=body(NOW) if method == "PUT" else None)
    assert r.status_code == 401
    assert r.json() == {"error": "Not signed in"}


async def test_tampered_cookie_is_signed_out(client):
    client.cookies.set("tunegraph_session", "forged.sig")
    assert (await client.get("/api/history")).status_code == 401


async def test_save_list_and_fetch_round_trip(client):
    await _sign_in(client)
    assert (await client.get("/api/history")).json() == {"sessions": []}
    r = await client.put("/api/history/s1", json=body(NOW - 1000, seed="Creep", mode="track", stops=3))
    assert r.status_code == 200
    meta = {"id": "s1", "seed": "Creep", "mode": "track", "stops": 3, "updated_at": NOW - 1000}
    assert r.json() == {"sessions": [meta]}
    assert (await client.get("/api/history")).json() == {"sessions": [meta]}
    full = (await client.get("/api/history/s1")).json()
    assert full == {**meta, "map": snapshot()}
    assert (await client.get("/api/history/missing")).status_code == 404


async def test_list_is_newest_first_and_update_moves_a_session_up(client):
    await _sign_in(client)
    for i, sid in enumerate(["a", "b", "c"]):
        await client.put(f"/api/history/{sid}", json=body(NOW - 10_000 + i))
    assert [s["id"] for s in (await client.get("/api/history")).json()["sessions"]] == ["c", "b", "a"]
    await client.put("/api/history/a", json=body(NOW, stops=4))
    sessions = (await client.get("/api/history")).json()["sessions"]
    assert [s["id"] for s in sessions] == ["a", "c", "b"]
    assert sessions[0]["stops"] == 4


async def test_keeps_the_newest_five_and_drops_the_oldest_document(client):
    await _sign_in(client)
    for i in range(6):
        await client.put(f"/api/history/s{i}", json=body(NOW - 60_000 + i))
    ids = [s["id"] for s in (await client.get("/api/history")).json()["sessions"]]
    assert ids == ["s5", "s4", "s3", "s2", "s1"]
    assert (await client.get("/api/history/s0")).status_code == 404
    assert await user_store.memory_store().get(f"{HISTORY_PREFIX}mock-user:s0") is None
    # A merged session older than the 5 kept ones is not stored at all.
    r = await client.put("/api/history/old", json=body(1))
    assert [s["id"] for s in r.json()["sessions"]] == ids
    assert (await client.get("/api/history/old")).status_code == 404


async def test_future_times_clamp_to_now(client):
    await _sign_in(client)
    r = await client.put("/api/history/s1", json=body(NOW + 10 ** 9))
    assert r.json()["sessions"][0]["updated_at"] <= int(time.time() * 1000)


async def test_delete_one_and_clear_all(client):
    await _sign_in(client)
    for i, sid in enumerate(["a", "b"]):
        await client.put(f"/api/history/{sid}", json=body(NOW - 10 + i))
    r = await client.delete("/api/history/b")
    assert [s["id"] for s in r.json()["sessions"]] == ["a"]
    assert (await client.get("/api/history/b")).status_code == 404
    assert (await client.delete("/api/history")).json() == {"sessions": []}
    assert (await client.get("/api/history")).json() == {"sessions": []}
    assert (await client.get("/api/history/a")).status_code == 404


async def test_sessions_are_per_account(client):
    await _sign_in(client)
    await client.put("/api/history/s1", json=body(NOW))
    store = user_store.memory_store()
    await store.set(f"{HISTORY_PREFIX}someone-else", {"sessions": [{"id": "x", "seed": "X", "mode": "artist", "stops": 1, "updated_at": 1}]})
    assert [s["id"] for s in (await client.get("/api/history")).json()["sessions"]] == ["s1"]
    assert (await client.get("/api/history/x")).status_code == 404


def _big_snapshot() -> str:
    raw = snapshot()
    # UTF-8 bytes, not characters: 4-byte notes push the text just over 1 MB.
    return raw[:-1] + ', "pad": "' + "🎵" * (MAP_BYTE_LIMIT // 4) + '"}'


@pytest.mark.parametrize("payload,status", [
    (_big_snapshot(), 413),
    (snapshot(count=MAP_NODE_LIMIT + 1), 413),
    ("{broken", 422),
    (json.dumps({"version": 2, "rootId": "a", "nodes": [{"id": "a"}], "edges": []}), 422),
    (json.dumps({"version": 1, "rootId": "a", "nodes": [], "edges": []}), 422),
    (json.dumps({"version": 1, "rootId": "gone", "nodes": [{"id": "a"}], "edges": []}), 422),
    (json.dumps({"version": 1, "rootId": "a", "nodes": [{"id": "a"}]}), 422),
    (json.dumps([1, 2]), 422),
])
async def test_bad_or_oversize_maps_are_rejected_and_not_stored(client, payload, status):
    await _sign_in(client)
    r = await client.put("/api/history/s1", json=body(NOW, map=payload))
    assert r.status_code == status
    assert (await client.get("/api/history")).json() == {"sessions": []}


async def test_largest_allowed_map_is_kept(client):
    await _sign_in(client)
    r = await client.put("/api/history/s1", json=body(NOW, map=snapshot(count=MAP_NODE_LIMIT)))
    assert r.status_code == 200


@pytest.mark.parametrize("overrides", [
    {"mode": "playlist"}, {"seed": ""}, {"stops": -1}, {"updated_at": -5}, {"map": ""},
])
async def test_bad_metadata_is_rejected(client, overrides):
    await _sign_in(client)
    assert (await client.put("/api/history/s1", json={**body(NOW), **overrides})).status_code == 422


@pytest.mark.parametrize("sid", ["a" * 65, "bad.id", "sp ace"])
async def test_bad_ids_are_rejected(client, sid):
    await _sign_in(client)
    assert (await client.put(f"/api/history/{sid}", json=body(NOW))).status_code == 422
    assert (await client.get(f"/api/history/{sid}")).status_code == 404


async def test_sign_out_stops_history_access(client):
    await _sign_in(client)
    await client.put("/api/history/s1", json=body(NOW))
    await client.post("/api/auth/signout")
    assert (await client.get("/api/history")).status_code == 401
