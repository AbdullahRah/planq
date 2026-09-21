"""Tests for api/extend_extract.py. Every Extend call is mocked — no network, no credits.

Run: python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "api"))

# These tests exercise real SDK error types, so they need the Python deps. On a
# fresh clone they will not be there; skip loudly rather than failing `npm test`
# for someone who has not run `pip install -r requirements.txt` yet.
try:
    import extend_extract as ex
    from extend_ai.core.api_error import ApiError
    from extend_ai.wrapper.polling import PollingTimeoutError
except ImportError as exc:  # pragma: no cover - environment guard
    print(f"SKIPPED: Extend Python tests need `pip install -r requirements.txt` ({exc})")
    sys.exit(0)


class FakeRun:
    """Stands in for extend_ai.types.extract_run.ExtractRun."""

    def __init__(
        self,
        status: str,
        id: str = "exr_test",
        output: Any = None,
        failure_reason: Optional[str] = None,
        failure_message: Optional[str] = None,
    ) -> None:
        self.status = status
        self.id = id
        self.output = output
        self.failure_reason = failure_reason
        self.failure_message = failure_message


class FakeExtractRuns:
    def __init__(self, behaviour: List[Any]) -> None:
        self.behaviour = list(behaviour)
        self.calls: List[Dict[str, Any]] = []

    def create_and_poll(self, **kwargs: Any) -> FakeRun:
        self.calls.append(kwargs)
        outcome = self.behaviour.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeClient:
    def __init__(self, behaviour: List[Any]) -> None:
        self.extract_runs = FakeExtractRuns(behaviour)


def api_error(code: str, retryable: bool, status: int = 400) -> ApiError:
    return ApiError(
        status_code=status,
        body={"code": code, "message": f"{code} happened", "retryable": retryable,
              "requestId": "req_abc"},
    )


class LoadConfigTests(unittest.TestCase):
    def test_real_config_file_loads(self) -> None:
        config = ex.load_config()
        self.assertEqual(config["baseProcessor"], "extraction_performance")
        self.assertEqual(config["parseConfig"]["engine"], "parse_performance")
        self.assertTrue(config["advancedOptions"]["citationsEnabled"])
        self.assertEqual(config["advancedOptions"]["citationMode"], "block")
        self.assertEqual(
            config["advancedOptions"]["arrayStrategy"], {"type": "large_array_max_context"}
        )

    def test_documentation_keys_are_stripped(self) -> None:
        """`_comment` must never reach the API, which validates the body strictly."""
        config = ex.load_config()
        self.assertNotIn("_comment", config)
        self.assertNotIn("_comment", json.dumps(config))

    def test_base_version_is_not_pinned(self) -> None:
        self.assertNotIn("baseVersion", ex.load_config())

    def test_missing_file_raises_config_error(self) -> None:
        with self.assertRaises(ex.ExtendConfigError):
            ex.load_config(REPO_ROOT / "extend" / "does-not-exist.json")

    def test_strip_is_recursive(self) -> None:
        cleaned = ex._strip_private_keys({"a": 1, "_x": 2, "n": {"_y": 3, "b": 4}, "l": [{"_z": 5}]})
        self.assertEqual(cleaned, {"a": 1, "n": {"b": 4}, "l": [{}]})


class BuildClientTests(unittest.TestCase):
    def test_missing_key_raises_auth_error(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ex.ExtendAuthError) as ctx:
                ex.build_client()
        self.assertIn("EXTEND_API_KEY", str(ctx.exception))

    def test_key_present_builds_client(self) -> None:
        with mock.patch.dict("os.environ", {"EXTEND_API_KEY": "sk_test"}, clear=True):
            with mock.patch.object(ex, "Extend") as ctor:
                ex.build_client()
        ctor.assert_called_once_with(token="sk_test")


class ErrorDetailTests(unittest.TestCase):
    def test_documented_envelope_is_read(self) -> None:
        details = ex.error_details(api_error("RATE_LIMIT_EXCEEDED", True, 429))
        self.assertEqual(details["code"], "RATE_LIMIT_EXCEEDED")
        self.assertTrue(details["retryable"])
        self.assertEqual(details["requestId"], "req_abc")
        self.assertEqual(details["statusCode"], 429)

    def test_missing_body_defaults_to_not_retryable(self) -> None:
        """Retrying what the API did not mark retryable burns credits for nothing."""
        details = ex.error_details(ApiError(status_code=500, body=None))
        self.assertFalse(details["retryable"])
        self.assertEqual(details["code"], "HTTP_500")


class RunExtractTests(unittest.TestCase):
    config: Dict[str, Any] = {"baseProcessor": "extraction_performance"}

    def test_processed_run_returns_output(self) -> None:
        payload = {"value": {"rooms": [{"room_name": "KITCHEN"}]}, "metadata": {}}
        client = FakeClient([FakeRun("PROCESSED", id="exr_1", output=payload)])

        result = ex.run_extract("https://signed", "A1.pdf", client=client, config=self.config)

        self.assertTrue(result["ok"])
        self.assertEqual(result["runId"], "exr_1")
        self.assertEqual(result["output"], payload)
        self.assertEqual(result["attempts"], 1)

    def test_file_is_passed_as_url_not_base64(self) -> None:
        client = FakeClient([FakeRun("PROCESSED", output={})])
        ex.run_extract("https://signed", "A1.pdf", client=client, config=self.config)
        call = client.extract_runs.calls[0]
        self.assertEqual(call["file"], {"url": "https://signed", "name": "A1.pdf"})
        self.assertEqual(call["config"], self.config)

    def test_retryable_error_is_retried_then_succeeds(self) -> None:
        client = FakeClient([
            api_error("RATE_LIMIT_EXCEEDED", True, 429),
            FakeRun("PROCESSED", output={"value": {}}),
        ])
        slept: List[float] = []

        result = ex.run_extract("https://signed", "A1.pdf", client=client,
                                config=self.config, sleep=slept.append)

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(len(slept), 1)

    def test_non_retryable_error_is_not_retried(self) -> None:
        client = FakeClient([api_error("UNAUTHORIZED", False, 401)])
        slept: List[float] = []

        result = ex.run_extract("https://signed", "A1.pdf", client=client,
                                config=self.config, sleep=slept.append)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "UNAUTHORIZED")
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(slept, [], "a non-retryable error must not back off and retry")

    def test_usage_blocked_surfaces_plainly(self) -> None:
        client = FakeClient([api_error("USAGE_BLOCKED", False, 403)])
        result = ex.run_extract("https://signed", "A1.pdf", client=client, config=self.config)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "USAGE_BLOCKED")

    def test_retryable_error_gives_up_after_max_attempts(self) -> None:
        client = FakeClient([api_error("INTERNAL_ERROR", True, 500) for _ in range(3)])
        result = ex.run_extract("https://signed", "A1.pdf", client=client,
                                config=self.config, sleep=lambda _: None)
        self.assertFalse(result["ok"])
        self.assertEqual(result["attempts"], 3)

    def test_failed_run_reports_reason_and_is_not_an_empty_success(self) -> None:
        """A sheet Extend could not read must never look like a clean extraction."""
        client = FakeClient([
            FakeRun("FAILED", id="exr_9", failure_reason="PARSING_ERROR",
                    failure_message="could not parse page 3"),
        ])

        result = ex.run_extract("https://signed", "A1.pdf", client=client, config=self.config)

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["error"]["code"], "PARSING_ERROR")
        self.assertIn("could not parse page 3", result["error"]["message"])
        self.assertEqual(result["runId"], "exr_9")

    def test_polling_timeout_is_reported_not_swallowed(self) -> None:
        client = FakeClient([PollingTimeoutError("timed out after 240000ms", 240_000, 240_000)])
        result = ex.run_extract("https://signed", "A1.pdf", client=client, config=self.config)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "POLLING_TIMEOUT")
        self.assertFalse(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
