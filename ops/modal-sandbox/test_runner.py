# pyright: reportMissingImports=false
"""
Unit tests for the Modal sandbox runner's HTTP surface.

Run from ops/modal-sandbox:  uv run --group dev pytest test_runner.py

These tests exercise the FastAPI app with the Modal SDK calls monkeypatched —
no Modal account or network access needed. They pin the two regressions behind
the production `modal runner 500 /sandbox/create: Internal Server Error`
incident (2026-07-09):

  1. The durable "agent" image's browserd/browserctl add_local_file layers are
     hydrated lazily at the first Sandbox.create — inside the deployed runner
     container, where the repo's browser/ dir doesn't exist. _browser_asset must
     resolve to a real file both at deploy time (source tree) and in-container
     (/assets/browser baked into the runner image).
  2. Unhandled exceptions in create/restore/run must surface as structured JSON
     detail (actionable in the TS driver's error message), never as FastAPI's
     bare text "Internal Server Error".
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import runner

TOKEN = "test-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}

CREATE_BODY = {
    "image": "agent",
    "memory_mb": 2048,
    "ttl_seconds": 86_400,
    "idle_timeout_seconds": 1_200,
    "network": "allow",
    "org_id": "org_test",
    "workspace_id": "ws_test",
}

RESTORE_BODY = {
    "snapshot_id": "im-fake",
    "memory_mb": 2048,
    "ttl_seconds": 86_400,
    "idle_timeout_seconds": 1_200,
    "network": "allow",
    "org_id": "org_test",
    "workspace_id": "ws_test",
}


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MODAL_RUNNER_TOKEN", TOKEN)
    # raise_server_exceptions=False so an escaped exception renders the way it
    # would in production (starlette's plain-text 500) and the test can assert
    # it does NOT happen.
    return TestClient(runner.web, raise_server_exceptions=False)


# ── _browser_asset ────────────────────────────────────────────────────────────


def test_browser_asset_resolves_source_tree() -> None:
    # At deploy time (repo checkout) the source browser/ dir wins.
    path = Path(runner._browser_asset("browserd.py"))
    assert path.is_file()
    assert path.parent == Path(runner.__file__).parent / "browser"


def test_browser_asset_falls_back_to_baked_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Simulate the deployed container: source dir missing, /assets/browser baked.
    baked = tmp_path / "assets" / "browser"
    baked.mkdir(parents=True)
    (baked / "browserd.py").write_text("# baked\n")
    monkeypatch.setattr(runner, "_BROWSER_SRC_DIR", tmp_path / "nonexistent")
    monkeypatch.setattr(runner, "_BROWSER_BAKED_DIR", baked)
    assert runner._browser_asset("browserd.py") == str(baked / "browserd.py")


def test_browser_asset_missing_everywhere_returns_source_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(runner, "_BROWSER_SRC_DIR", tmp_path / "nope")
    monkeypatch.setattr(runner, "_BROWSER_BAKED_DIR", tmp_path / "also-nope")
    assert runner._browser_asset("browserd.py") == str(tmp_path / "nope" / "browserd.py")


# ── _runner_app ───────────────────────────────────────────────────────────────


def test_runner_app_is_none_when_unhydrated() -> None:
    # Outside a Modal container the module-level App has no app_id; passing it
    # to Sandbox.create would raise ValueError in SDK >= 1.4. We must hand the
    # SDK None so it falls back to the implicit container app.
    assert runner.app.app_id is None
    assert runner._runner_app() is None


# ── auth ──────────────────────────────────────────────────────────────────────


def test_create_requires_bearer_token(client: TestClient) -> None:
    res = client.post("/sandbox/create", json=CREATE_BODY)
    assert res.status_code == 401
    assert res.json() == {"detail": "missing bearer token"}


def test_create_rejects_wrong_token(client: TestClient) -> None:
    res = client.post(
        "/sandbox/create", json=CREATE_BODY, headers={"authorization": "Bearer nope"}
    )
    assert res.status_code == 401
    assert res.json() == {"detail": "invalid bearer token"}


# ── /sandbox/create ───────────────────────────────────────────────────────────


def test_create_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_create(*args: object, **kwargs: object) -> SimpleNamespace:
        assert kwargs["memory"] == 2048
        assert kwargs["timeout"] == 86_400
        assert kwargs["idle_timeout"] == 1_200
        assert kwargs["block_network"] is False
        return SimpleNamespace(object_id="sb-123")

    monkeypatch.setattr(runner, "_create_sandbox", fake_create)
    res = client.post("/sandbox/create", json=CREATE_BODY, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["sandbox_id"] == "sb-123"
    assert body["status"] == "running"


def test_create_surfaces_hydration_failure_as_json_detail(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The incident shape: lazy agent-image hydration inside the container blew
    # up with FileNotFoundError and FastAPI replied with a bare text
    # "Internal Server Error". The endpoint must return structured JSON naming
    # the exception instead.
    async def fake_create(*args: object, **kwargs: object) -> SimpleNamespace:
        raise FileNotFoundError("local file browser/browserd.py does not exist")

    monkeypatch.setattr(runner, "_create_sandbox", fake_create)
    res = client.post("/sandbox/create", json=CREATE_BODY, headers=AUTH)
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "sandbox create failed" in detail
    assert "FileNotFoundError" in detail
    assert "browserd.py" in detail


def test_create_setup_cmd_exec_error_terminates_and_surfaces(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_create(*args: object, **kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(object_id="sb-456")

    terminated: list[str] = []

    async def fake_exec(sb: SimpleNamespace, *argv: str, **kwargs: object) -> None:
        raise RuntimeError("exec transport lost")

    async def fake_terminate(sb: SimpleNamespace) -> None:
        terminated.append(sb.object_id)

    fake_modal = SimpleNamespace(
        Sandbox=SimpleNamespace(
            exec=SimpleNamespace(aio=fake_exec),
            terminate=SimpleNamespace(aio=fake_terminate),
        )
    )
    monkeypatch.setattr(runner, "_create_sandbox", fake_create)
    monkeypatch.setattr(runner, "modal", fake_modal)

    res = client.post(
        "/sandbox/create", json={**CREATE_BODY, "setup_cmd": "git clone x"}, headers=AUTH
    )
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "sandbox setup_cmd failed" in detail
    assert "RuntimeError" in detail
    assert terminated == ["sb-456"]


def test_create_rejects_unknown_image_kind(client: TestClient) -> None:
    res = client.post("/sandbox/create", json={**CREATE_BODY, "image": "java"}, headers=AUTH)
    # Pydantic Literal validation rejects it before the handler runs.
    assert res.status_code == 422


# ── /sandbox/restore ──────────────────────────────────────────────────────────


def test_restore_surfaces_create_failure_as_json_detail(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_modal = SimpleNamespace(
        Image=SimpleNamespace(from_id=lambda snapshot_id: SimpleNamespace(object_id=snapshot_id))
    )

    async def fake_create(*args: object, **kwargs: object) -> SimpleNamespace:
        raise RuntimeError("resource exhausted")

    monkeypatch.setattr(runner, "modal", fake_modal)
    monkeypatch.setattr(runner, "_create_sandbox", fake_create)
    res = client.post("/sandbox/restore", json=RESTORE_BODY, headers=AUTH)
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "sandbox restore failed" in detail
    assert "RuntimeError" in detail


# ── /run ──────────────────────────────────────────────────────────────────────


def test_run_surfaces_sandbox_failure_as_json_detail(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_run(req: object) -> None:
        raise FileNotFoundError("local file gone")

    monkeypatch.setattr(runner, "_run_sandbox", fake_run)
    res = client.post(
        "/run",
        json={
            "language": "python",
            "code": "print(1)",
            "timeout_ms": 5000,
            "memory_mb": 512,
            "network": "deny",
            "org_id": "org_test",
            "workspace_id": "ws_test",
        },
        headers=AUTH,
    )
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "run failed" in detail
    assert "FileNotFoundError" in detail


# ── _create_sandbox kwarg degradation ────────────────────────────────────────


def test_create_sandbox_drops_unsupported_kwargs_one_at_a_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, object]] = []

    async def fake_sdk_create(*args: object, **kwargs: object) -> SimpleNamespace:
        seen.append(dict(kwargs))
        if "ephemeral_disk" in kwargs or "cpu" in kwargs:
            raise TypeError("unexpected keyword argument")
        return SimpleNamespace(object_id="sb-deg")

    fake_modal = SimpleNamespace(Sandbox=SimpleNamespace(create=SimpleNamespace(aio=fake_sdk_create)))
    monkeypatch.setattr(runner, "modal", fake_modal)

    sb = asyncio.run(
        runner._create_sandbox("sleep", "infinity", cpu=2.0, ephemeral_disk=10_240, memory=1024)
    )
    assert sb.object_id == "sb-deg"
    # Dropped ephemeral_disk first, then cpu; memory survives throughout.
    assert len(seen) == 3
    assert all("memory" in k for k in seen)
    assert "ephemeral_disk" not in seen[-1] and "cpu" not in seen[-1]
