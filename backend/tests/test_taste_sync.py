"""Account copy of the taste profile (#76): merge rules, auth guards and mock-mode sync."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.cache import cache
from app.config import get_settings
from app.models.taste import StoredTasteProfile
from app.services import user_store
from app.services.sessions import COOKIE_NAME
from app.services.taste_sync import TASTE_LIMIT, merge_taste, read_taste
from app.services.user_store import USER_PREFIX


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


def profile(**lists) -> StoredTasteProfile:
    return StoredTasteProfile(**lists)


# ---- merge rules ------------------------------------------------------------------

def test_merge_unions_each_list_with_case_insensitive_dedupe():
    cloud = profile(liked_artists=["Radiohead", "Portishead"], disliked=["Harsh vocals"])
    local = profile(liked_artists=[" radiohead", "Massive Attack"], liked_tracks=["Creep — Radiohead"],
                    liked_genres=["Dream pop"], disliked=["HARSH VOCALS", "Polka"])
    merged, added, capped = merge_taste(cloud, local)
    assert merged.liked_artists == ["Radiohead", "Portishead", "Massive Attack"]
    assert merged.liked_tracks == ["Creep — Radiohead"]
    assert merged.liked_genres == ["Dream pop"]
    assert merged.disliked == ["Harsh vocals", "Polka"]
    assert added == 4
    assert capped == []


def test_merge_into_an_empty_account_keeps_every_local_entry():
    local = profile(liked_artists=["Björk"], disliked=["Noise"], notes="Slow songs")
    merged, added, capped = merge_taste(None, local)
    assert merged == local
    assert added == 3
    assert capped == []


def test_merge_of_nothing_adds_nothing():
    cloud = profile(liked_artists=["Radiohead"], notes="Cloud notes")
    merged, added, capped = merge_taste(cloud, StoredTasteProfile())
    assert merged == cloud
    assert (added, capped) == (0, [])
    merged, added, _ = merge_taste(cloud, profile(liked_artists=["RADIOHEAD"], notes="Cloud notes"))
    assert merged == cloud and added == 0


def test_notes_keep_cloud_unless_cloud_notes_are_empty():
    local = profile(notes="Local notes")
    assert merge_taste(profile(notes="Cloud notes"), local)[0].notes == "Cloud notes"
    assert merge_taste(profile(notes="   "), local)[0].notes == "Local notes"
    assert merge_taste(None, local)[0].notes == "Local notes"
    assert merge_taste(profile(notes="Cloud notes"), StoredTasteProfile())[0].notes == "Cloud notes"


def test_merge_enforces_the_cap_and_reports_capped_lists():
    cloud = profile(liked_artists=[f"Cloud {i}" for i in range(TASTE_LIMIT - 2)], liked_genres=[f"G{i}" for i in range(TASTE_LIMIT)])
    local = profile(liked_artists=[f"Local {i}" for i in range(5)], liked_genres=["New genre"], disliked=["Polka"])
    merged, added, capped = merge_taste(cloud, local)
    assert len(merged.liked_artists) == TASTE_LIMIT
    assert merged.liked_artists[-2:] == ["Local 0", "Local 1"]
    assert merged.liked_genres == cloud.liked_genres
    assert merged.disliked == ["Polka"]
    assert added == 3
    assert capped == ["liked_artists", "liked_genres"]


def test_merge_at_exactly_the_cap_is_not_capped():
    cloud = profile(liked_artists=[f"Cloud {i}" for i in range(TASTE_LIMIT - 1)])
    merged, added, capped = merge_taste(cloud, profile(liked_artists=["Last"]))
    assert len(merged.liked_artists) == TASTE_LIMIT
    assert (added, capped) == (1, [])


def test_read_taste_tolerates_missing_or_bad_documents():
    assert read_taste({}) is None
    assert read_taste({"taste": "nope"}) is None
    assert read_taste({"taste": {"liked_artists": "nope"}}) is None
    assert read_taste({"taste": {}}) is None
    assert read_taste({"taste": {"disliked": ["Polka"]}}) == profile(disliked=["Polka"])


# ---- auth guards ------------------------------------------------------------------

@pytest.mark.parametrize("method,path", [("GET", "/api/user/taste"), ("PUT", "/api/user/taste"), ("POST", "/api/user/taste/merge")])
async def test_unsigned_requests_return_401(client, method, path):
    r = await client.request(method, path, json={"liked_artists": ["Radiohead"]})
    assert r.status_code == 401
    assert r.json() == {"error": "Not signed in"}
    client.cookies.set(COOKIE_NAME, "forged.0000")
    assert (await client.request(method, path, json={})).status_code == 401


async def test_ended_session_returns_401(client):
    await client.post("/api/auth/mock")
    cookie = client.cookies.get(COOKIE_NAME)
    await client.post("/api/auth/signout")
    client.cookies.set(COOKIE_NAME, cookie)
    assert (await client.get("/api/user/taste")).status_code == 401


async def test_unsigned_request_needs_no_store_outside_mock_mode(client, monkeypatch):
    monkeypatch.setenv("TUNEGRAPH_MOCK", "0")
    get_settings.cache_clear()
    assert (await client.get("/api/user/taste")).status_code == 401


# ---- mock-mode sync with the in-memory store ---------------------------------------

async def test_put_get_and_clear_round_trip(client):
    await client.post("/api/auth/mock")
    assert (await client.get("/api/user/taste")).json() == {"profile": None}
    body = {"liked_artists": ["Radiohead"], "liked_tracks": [], "liked_genres": [], "disliked": ["Polka"], "notes": ""}
    r = await client.put("/api/user/taste", json=body)
    assert r.status_code == 200
    assert r.json()["profile"] == body
    assert (await client.get("/api/user/taste")).json()["profile"] == body
    user = await user_store.memory_store().get(USER_PREFIX + "mock-user")
    assert user["email"] == "listener@example.com" and user["taste"] == body
    # Dislikes alone are a valid synced profile; an empty profile clears the account copy.
    r = await client.put("/api/user/taste", json={"disliked": ["Polka"]})
    assert r.json()["profile"]["disliked"] == ["Polka"]
    r = await client.put("/api/user/taste", json={})
    assert r.json() == {"profile": None}
    assert (await client.get("/api/user/taste")).json() == {"profile": None}


async def test_put_rejects_over_cap_or_bad_entries(client):
    await client.post("/api/auth/mock")
    assert (await client.put("/api/user/taste", json={"liked_artists": ["x"] * (TASTE_LIMIT + 1)})).status_code == 422
    assert (await client.put("/api/user/taste", json={"liked_artists": ["x" * 121]})).status_code == 422
    assert (await client.put("/api/user/taste", json={"notes": "x" * 501})).status_code == 422


async def test_first_sign_in_merges_and_a_second_device_sees_the_result(client):
    await client.post("/api/auth/mock")
    await client.put("/api/user/taste", json={"liked_artists": ["Radiohead"], "notes": ""})
    local = {"liked_artists": ["radiohead", "Portishead"], "disliked": ["Polka"], "notes": "Slow songs"}
    r = await client.post("/api/user/taste/merge", json=local)
    assert r.status_code == 200
    merged = r.json()
    assert merged["added"] == 3 and merged["capped"] == []
    assert merged["profile"]["liked_artists"] == ["Radiohead", "Portishead"]
    assert merged["profile"]["notes"] == "Slow songs"

    async with await _client() as other_device:
        await other_device.post("/api/auth/mock")
        assert (await other_device.get("/api/user/taste")).json()["profile"] == merged["profile"]
        # The second device has nothing local: the merge adds nothing and keeps the account copy.
        r = await other_device.post("/api/user/taste/merge", json={})
        assert r.json() == {"profile": merged["profile"], "added": 0, "capped": []}


async def test_merge_reports_the_cap(client):
    await client.post("/api/auth/mock")
    await client.put("/api/user/taste", json={"liked_artists": [f"A{i}" for i in range(TASTE_LIMIT)]})
    r = await client.post("/api/user/taste/merge", json={"liked_artists": ["Extra"], "liked_genres": ["Dream pop"]})
    body = r.json()
    assert body["added"] == 1 and body["capped"] == ["liked_artists"]
    assert len(body["profile"]["liked_artists"]) == TASTE_LIMIT and body["profile"]["liked_genres"] == ["Dream pop"]
