"""Account copy of the Library lists (#79): merge rules, caps, auth guards and mock-mode sync."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings
from app.models.library import BOOKMARK_LIMIT, EXCLUSION_LIMIT, LibraryEntry
from app.services import user_store
from app.services.library_sync import LIBRARY_PREFIX, bookmark_key, exclusion_key, merge_entries
from app.services.sessions import COOKIE_NAME


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for name in ("VERCEL", "SESSION_COOKIE_SECURE", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
                 "KV_REST_API_URL", "KV_REST_API_TOKEN", "SESSION_SECRET", "GOOGLE_CLIENT_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TUNEGRAPH_MOCK", "1")
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()
    yield
    get_settings.cache_clear()
    cache.clear()
    user_store.memory_store().clear()


async def _client():
    from app.main import app

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
async def client():
    async with await _client() as c:
        yield c


def artist(id: str, saved_at: float = 1) -> dict:
    return {"kind": "artist", "item": {"id": id, "name": f"Artist {id}"}, "savedAt": saved_at}


def song(id: str, saved_at: float = 1) -> dict:
    return {"kind": "track", "item": {"id": id, "name": f"Song {id}", "artist": {"id": "a", "name": "Artist a"}},
            "savedAt": saved_at}


def entries(*items: dict) -> list[LibraryEntry]:
    return [LibraryEntry.model_validate(v) for v in items]


def ids(merged: list[LibraryEntry]) -> list[str]:
    return [e.item.id for e in merged]


def listing(*items: dict) -> dict:
    return {"version": 1, "items": list(items)}


# ---- merge rules ------------------------------------------------------------------

def test_merge_unions_by_kind_and_id_newest_first():
    cloud = entries(artist("x", 10), song("s", 5))
    # The same id as an artist and as a song are two different bookmarks.
    local = entries(song("x", 20), artist("y", 1))
    merged, added, capped, changed = merge_entries(cloud, local, bookmark_key, BOOKMARK_LIMIT)
    assert [bookmark_key(e) for e in merged] == ["track:x", "artist:x", "track:s", "artist:y"]
    assert (added, capped, changed) == (2, False, True)


def test_duplicate_keeps_the_newer_saved_at_and_is_not_counted_as_added():
    cloud = entries(artist("x", 10), artist("y", 30))
    local = entries(artist("x", 50), artist("y", 5))
    merged, added, capped, changed = merge_entries(cloud, local, bookmark_key, BOOKMARK_LIMIT)
    assert [(e.item.id, e.savedAt) for e in merged] == [("x", 50), ("y", 30)]
    assert (added, capped, changed) == (0, False, True)
    # Nothing new and nothing newer: no change, so the route writes nothing.
    assert merge_entries(cloud, entries(artist("y", 30)), bookmark_key, BOOKMARK_LIMIT)[1:] == (0, False, False)
    assert merge_entries(cloud, [], bookmark_key, BOOKMARK_LIMIT)[1:] == (0, False, False)


def test_merge_into_an_empty_account_keeps_every_local_entry():
    local = entries(artist("x", 2), song("s", 3))
    merged, added, capped, _ = merge_entries([], local, bookmark_key, BOOKMARK_LIMIT)
    assert ids(merged) == ["s", "x"]
    assert (added, capped) == (2, False)


def test_merge_enforces_the_cap_keeps_every_cloud_entry_and_adds_the_newest_local_first():
    cloud = entries(*[artist(f"c{i}", 100 + i) for i in range(BOOKMARK_LIMIT - 2)])
    local = entries(artist("old", 1), artist("new", 3), artist("mid", 2))
    merged, added, capped, _ = merge_entries(cloud, local, bookmark_key, BOOKMARK_LIMIT)
    assert len(merged) == BOOKMARK_LIMIT
    assert {e.item.id for e in cloud} <= set(ids(merged))
    assert ids(merged)[-2:] == ["new", "mid"]
    assert (added, capped) == (2, True)


def test_merge_at_exactly_the_cap_is_not_capped():
    cloud = entries(*[song(f"c{i}", 10) for i in range(EXCLUSION_LIMIT - 1)])
    merged, added, capped, _ = merge_entries(cloud, entries(song("last", 1)), exclusion_key, EXCLUSION_LIMIT)
    assert len(merged) == EXCLUSION_LIMIT
    assert (added, capped) == (1, False)


def test_a_full_account_adds_nothing_but_reports_the_cap():
    cloud = entries(*[song(f"c{i}", 10) for i in range(EXCLUSION_LIMIT)])
    merged, added, capped, changed = merge_entries(cloud, entries(song("extra", 99)), exclusion_key, EXCLUSION_LIMIT)
    assert ids(merged) == ids(cloud)
    assert (added, capped, changed) == (0, True, False)


# ---- auth guards ------------------------------------------------------------------

LIBRARY_ROUTES = [
    ("GET", "/api/user/library", None),
    ("PUT", "/api/user/library/bookmarks", listing(artist("x"))),
    ("PUT", "/api/user/library/exclusions", listing(song("s"))),
    ("POST", "/api/user/library/merge", {"bookmarks": listing(artist("x")), "exclusions": listing()}),
]


@pytest.mark.parametrize("method,path,body", LIBRARY_ROUTES)
async def test_unsigned_requests_return_401(client, method, path, body):
    r = await client.request(method, path, json=body)
    assert r.status_code == 401
    assert r.json() == {"error": "Not signed in"}
    client.cookies.set(COOKIE_NAME, "forged.0000")
    assert (await client.request(method, path, json=body)).status_code == 401
    assert not [k for k in user_store.memory_store()._data if k.startswith(LIBRARY_PREFIX)]


async def test_ended_session_returns_401(client):
    await client.post("/api/auth/mock")
    cookie = client.cookies.get(COOKIE_NAME)
    await client.post("/api/auth/signout")
    client.cookies.set(COOKIE_NAME, cookie)
    assert (await client.get("/api/user/library")).status_code == 401


async def test_unsigned_request_needs_no_store_outside_mock_mode(client, monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    assert (await client.get("/api/user/library")).status_code == 401


# ---- mock-mode sync with the in-memory store ---------------------------------------

async def test_put_get_and_clear_round_trip(client):
    await client.post("/api/auth/mock")
    empty = {"bookmarks": listing(), "exclusions": listing()}
    assert (await client.get("/api/user/library")).json() == empty
    saved = listing(song("s", 2), artist("x", 1))
    r = await client.put("/api/user/library/bookmarks", json=saved)
    assert r.status_code == 200
    assert r.json() == saved
    excluded = listing(song("e", 3))
    assert (await client.put("/api/user/library/exclusions", json=excluded)).json() == excluded
    assert (await client.get("/api/user/library")).json() == {"bookmarks": saved, "exclusions": excluded}
    # The lists are separate documents: clearing one keeps the other.
    assert (await client.put("/api/user/library/bookmarks", json=listing())).json() == listing()
    assert (await client.get("/api/user/library")).json() == {"bookmarks": listing(), "exclusions": excluded}
    assert await user_store.memory_store().get(f"{LIBRARY_PREFIX}mock-user:bookmarks") is None


async def test_put_keeps_optional_fields_and_dedupes(client):
    await client.post("/api/auth/mock")
    full = {"kind": "artist", "item": {"id": "x", "name": "X", "mbid": "m", "image_url": "https://i"}, "savedAt": 5}
    r = await client.put("/api/user/library/bookmarks", json=listing(artist("x", 1), full))
    assert r.json() == listing(full)


async def test_put_rejects_over_cap_or_bad_entries(client):
    await client.post("/api/auth/mock")
    over = listing(*[artist(f"a{i}") for i in range(BOOKMARK_LIMIT + 1)])
    assert (await client.put("/api/user/library/bookmarks", json=over)).status_code == 422
    over = listing(*[song(f"s{i}") for i in range(EXCLUSION_LIMIT + 1)])
    assert (await client.put("/api/user/library/exclusions", json=over)).status_code == 422
    # Not suggested keeps songs only; a song needs its artist; the version must be 1.
    assert (await client.put("/api/user/library/exclusions", json=listing(artist("x")))).status_code == 422
    no_artist = {"kind": "track", "item": {"id": "s", "name": "S"}, "savedAt": 1}
    assert (await client.put("/api/user/library/bookmarks", json=listing(no_artist))).status_code == 422
    assert (await client.put("/api/user/library/bookmarks", json={"version": 2, "items": []})).status_code == 422
    assert (await client.put("/api/user/library/bookmarks", json=listing({**artist("x"), "savedAt": -1}))).status_code == 422


async def test_first_sign_in_merges_and_a_second_device_sees_the_result(client):
    await client.post("/api/auth/mock")
    await client.put("/api/user/library/bookmarks", json=listing(artist("x", 10)))
    await client.put("/api/user/library/exclusions", json=listing(song("e", 10)))
    local = {"bookmarks": listing(artist("x", 20), song("s", 5)), "exclusions": listing(song("e", 1), song("f", 2))}
    r = await client.post("/api/user/library/merge", json=local)
    assert r.status_code == 200
    merged = r.json()
    assert merged["added"] == 2 and merged["capped"] == []
    assert merged["bookmarks"] == listing(artist("x", 20), song("s", 5))
    assert merged["exclusions"] == listing(song("e", 10), song("f", 2))

    async with await _client() as other_device:
        await other_device.post("/api/auth/mock")
        lists = {"bookmarks": merged["bookmarks"], "exclusions": merged["exclusions"]}
        assert (await other_device.get("/api/user/library")).json() == lists
        # The second device has nothing local: the merge adds nothing and keeps the account copy.
        r = await other_device.post("/api/user/library/merge", json={})
        assert r.json() == {**lists, "added": 0, "capped": []}


async def test_merge_reports_each_capped_list(client):
    await client.post("/api/auth/mock")
    await client.put("/api/user/library/exclusions", json=listing(*[song(f"c{i}", 10) for i in range(EXCLUSION_LIMIT)]))
    r = await client.post("/api/user/library/merge", json={
        "bookmarks": listing(artist("x")), "exclusions": listing(song("extra", 50)),
    })
    body = r.json()
    assert body["added"] == 1 and body["capped"] == ["exclusions"]
    assert len(body["exclusions"]["items"]) == EXCLUSION_LIMIT
    assert body["bookmarks"] == listing(artist("x"))


async def test_bad_stored_documents_read_as_empty(client):
    await client.post("/api/auth/mock")
    store = user_store.memory_store()
    await store.set(f"{LIBRARY_PREFIX}mock-user:bookmarks", {"items": "nope"})
    await store.set(f"{LIBRARY_PREFIX}mock-user:exclusions", {"items": [artist("x")]})
    assert (await client.get("/api/user/library")).json() == {"bookmarks": listing(), "exclusions": listing()}
