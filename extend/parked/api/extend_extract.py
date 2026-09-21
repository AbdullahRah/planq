"""Extend document extraction, exposed as a Vercel Python function.

Planq's application code is TypeScript, but the Extend integration is built on
the official Python SDK. Python therefore runs as its own Vercel function in the
root `api/` directory (Vercel's Python runtime owns `api/*.py`; Next.js owns
`app/api/*`, so the two do not collide) and `lib/extend-extract.ts` calls it over
HTTP from the real analyze path.

The extraction configuration is NOT written here. It lives in
extend/extract.config.json so it can be reviewed and iterated on without
touching code; this module only loads it and submits it inline.

Docs followed:
  https://docs.extend.ai/extraction/configuration
  https://docs.extend.ai/api-reference/endpoints/extract/create-extract-run
  https://docs.extend.ai/api-reference/error-handling
"""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from extend_ai import Extend
from extend_ai.core.api_error import ApiError
from extend_ai.wrapper.polling import PollingOptions, PollingTimeoutError

# extend/extract.config.json is the source of truth for the configuration. Resolve
# it from __file__ rather than the process cwd, because the cwd differs between
# `vercel dev`, the deployed function, and a local pytest run.
def _find_config() -> Path:
    """Locate extend/extract.config.json by walking up from this file.

    This module is deployable at api/extend_extract.py and parked at
    extend/parked/api/extend_extract.py, so its depth below the repo root is not
    fixed. Searching upward for the config keeps both layouts working and keeps
    the tests honest wherever the file currently sits.
    """
    for base in Path(__file__).resolve().parents:
        candidate = base / "extend" / "extract.config.json"
        if candidate.is_file():
            return candidate
    # Fall back to the deployed layout so the error names a sensible path.
    return Path(__file__).resolve().parent.parent / "extend" / "extract.config.json"


CONFIG_PATH = _find_config()
REPO_ROOT = CONFIG_PATH.parent.parent

# An architectural sheet through parse_performance with large_array_max_context
# is slow — minutes, not seconds. Give polling room, but stay under the Vercel
# function ceiling set in vercel.json so we fail with our own error rather than
# being killed mid-poll.
DEFAULT_MAX_WAIT_MS = 240_000

# Only RATE_LIMIT_EXCEEDED and INTERNAL_ERROR are retryable per the error-handling
# docs, and the API tells us which via the `retryable` boolean. We never infer it.
MAX_ATTEMPTS = 3


class ExtendConfigError(RuntimeError):
    """The config file is missing or unreadable — a deploy problem, not a run problem."""


class ExtendAuthError(RuntimeError):
    """EXTEND_API_KEY is absent. Surfaced distinctly so the caller can say so plainly."""


def _strip_private_keys(value: Any) -> Any:
    """Drop `_`-prefixed keys so documentation comments never reach the API.

    extract.config.json carries a top-level `_comment` explaining the file to
    whoever edits it next. The API validates its request body strictly, so an
    unknown field would come back as INVALID_REQUEST. Strip them recursively.
    """
    if isinstance(value, dict):
        return {k: _strip_private_keys(v) for k, v in value.items() if not k.startswith("_")}
    if isinstance(value, list):
        return [_strip_private_keys(v) for v in value]
    return value


def load_config(path: Path = CONFIG_PATH) -> Dict[str, Any]:
    """Read extend/extract.config.json and return it ready to submit inline."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ExtendConfigError(f"could not read Extend config at {path}: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExtendConfigError(f"Extend config at {path} is not valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ExtendConfigError(f"Extend config at {path} must be a JSON object")

    return _strip_private_keys(parsed)


def build_client() -> Extend:
    """Construct the SDK client from EXTEND_API_KEY, failing clearly when unset."""
    token = os.environ.get("EXTEND_API_KEY")
    if not token:
        raise ExtendAuthError(
            "EXTEND_API_KEY is not set. Add it to .env.local for local runs, or to the "
            "Vercel project environment for deploys."
        )
    return Extend(token=token)


def _as_plain(value: Any) -> Any:
    """Coerce an SDK pydantic model into JSON-safe primitives."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {k: _as_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_as_plain(v) for v in value]
    return value


def error_details(exc: ApiError) -> Dict[str, Any]:
    """Pull the documented error envelope off a raised SDK error.

    Per https://docs.extend.ai/api-reference/error-handling every error carries
    {code, message, retryable, requestId}. `body` arrives as the decoded JSON
    dict, but tolerate a pydantic model too so a future SDK change cannot turn a
    clean error message into an AttributeError.
    """
    body = _as_plain(getattr(exc, "body", None))
    if not isinstance(body, dict):
        body = {}

    return {
        "code": body.get("code") or f"HTTP_{getattr(exc, 'status_code', None) or 'UNKNOWN'}",
        "message": body.get("message") or str(exc),
        # Default to False. Retrying something the API did not mark retryable
        # burns credits and latency on an error that will not resolve itself.
        "retryable": bool(body.get("retryable", False)),
        "requestId": body.get("requestId") or body.get("request_id"),
        "statusCode": getattr(exc, "status_code", None),
    }


def run_extract(
    file_url: str,
    file_name: str,
    client: Optional[Extend] = None,
    config: Optional[Dict[str, Any]] = None,
    max_attempts: int = MAX_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, Any]:
    """Run one document through Extend and return a JSON-safe result.

    Uses the async run API (`create_and_poll`) rather than the sync `extract`
    endpoint, which the docs cap at five minutes and mark as onboarding-only.

    Returns a dict that always carries `ok`. On failure it carries `error` with
    the documented code/message/retryable/requestId, so the caller can report
    exactly what went wrong instead of treating a failed read as an empty sheet.
    """
    client = client or build_client()
    config = config if config is not None else load_config()

    attempt = 0
    last_error: Dict[str, Any] = {}

    while attempt < max_attempts:
        attempt += 1
        try:
            run = client.extract_runs.create_and_poll(
                file={"url": file_url, "name": file_name},
                config=config,
                polling_options=PollingOptions(max_wait_ms=DEFAULT_MAX_WAIT_MS),
            )
        except ApiError as exc:
            last_error = error_details(exc)
            # Only back off when the API says the condition is transient.
            if last_error["retryable"] and attempt < max_attempts:
                sleep(2 ** attempt)
                continue
            return {"ok": False, "error": last_error, "attempts": attempt}
        except PollingTimeoutError as exc:
            return {
                "ok": False,
                "error": {
                    "code": "POLLING_TIMEOUT",
                    "message": str(exc),
                    "retryable": False,
                    "requestId": None,
                },
                "attempts": attempt,
            }

        status = getattr(run, "status", None)
        run_id = getattr(run, "id", None)

        if status == "PROCESSED":
            return {
                "ok": True,
                "runId": run_id,
                "status": status,
                "output": _as_plain(getattr(run, "output", None)),
                "attempts": attempt,
            }

        # A terminal non-PROCESSED run (FAILED or CANCELLED) is reported with its
        # reason. This is never silently converted into an empty extraction: an
        # unread sheet must not look like a compliant one.
        return {
            "ok": False,
            "runId": run_id,
            "status": status,
            "error": {
                "code": _as_plain(getattr(run, "failure_reason", None)) or "RUN_NOT_PROCESSED",
                "message": _as_plain(getattr(run, "failure_message", None))
                or f"extract run finished with status {status}",
                "retryable": False,
                "requestId": run_id,
            },
            "attempts": attempt,
        }

    return {"ok": False, "error": last_error or {"code": "UNKNOWN", "message": "extract failed"},
            "attempts": attempt}


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel requires this name
    """POST {"url": "...", "name": "..."} -> the run_extract result as JSON."""

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's interface
        try:
            length = int(self.headers.get("Content-Length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"ok": False, "error": {"code": "INVALID_REQUEST",
                                                    "message": f"body is not valid JSON: {exc}",
                                                    "retryable": False}})
            return

        file_url = request.get("url")
        if not file_url:
            self._send(400, {"ok": False, "error": {"code": "INVALID_REQUEST",
                                                    "message": "'url' is required",
                                                    "retryable": False}})
            return

        try:
            result = run_extract(
                file_url=file_url,
                file_name=request.get("name") or "document",
            )
        except (ExtendAuthError, ExtendConfigError) as exc:
            code = "UNAUTHORIZED" if isinstance(exc, ExtendAuthError) else "INVALID_CONFIGURATION"
            self._send(500, {"ok": False, "error": {"code": code, "message": str(exc),
                                                    "retryable": False}})
            return

        self._send(200 if result.get("ok") else 502, result)
