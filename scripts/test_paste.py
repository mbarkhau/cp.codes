"""Run with: python3 -m unittest discover -s scripts -p 'test_paste.py'"""

import base64
from contextlib import redirect_stderr, redirect_stdout
import gzip
import hashlib
import io
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import paste


class PasteTests(unittest.TestCase):
    def challenge(self, content=b"hello", difficulty=8):
        return {
            "version": 1,
            "challenge_id": "ab" * 16,
            "nonce": "cd" * 16,
            "difficulty": difficulty,
            "content_hash": hashlib.sha256(content).hexdigest(),
            "byte_length": len(content),
            "algorithm": "sha256",
            "created_at": int(time.time() * 1000),
            "expires_at": int((time.time() + 600) * 1000),
            "expected_attempts_p50": 177,
            "signature": "opaque-server-signature",
        }

    def test_pow(self):
        for difficulty in (0, 1, 7, 8, 9, 16):
            challenge = self.challenge(difficulty=difficulty)
            solution, digest = paste.solve_pow(challenge, 10)
            expected = hashlib.sha256(
                f'{challenge["content_hash"]}:{challenge["challenge_id"]}:{challenge["nonce"]}:{solution}'.encode()
            ).hexdigest()
            self.assertEqual(digest, expected)
            self.assertLess(int(digest, 16), 1 << (256 - difficulty))
            self.assertRegex(solution, r"^(0|[1-9][0-9]*)$")

    def test_expired_and_search_timeout(self):
        challenge = self.challenge(difficulty=256)
        challenge["expires_at"] = 0
        with self.assertRaises(paste.ProofExpired):
            paste.solve_pow(challenge, 1)
        challenge["expires_at"] = int((time.time() + 600) * 1000)
        with patch.object(paste.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                paste.solve_pow(challenge, 1)

    def test_invalid_challenges(self):
        content = b"hello"
        for changes in (
            {"algorithm": "other"}, {"signature": ""}, {"difficulty": -1},
            {"difficulty": 257}, {"difficulty": True}, {"content_hash": "0" * 64},
            {"byte_length": 1}, {"nonce": "bad"}, {"expires_at": None},
        ):
            challenge = {**self.challenge(content), **changes}
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                paste.validate_challenge(challenge, hashlib.sha256(content).hexdigest(), len(content))

    def run_upload(self, rejection=None, stdin=False):
        # A local API verifies the actual HTTP payload and forces a fresh-challenge retry.
        content = "hello, café 🌍\r\n".encode("utf-8")
        challenges = []
        submissions = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/api/challenge":
                    test.assertEqual(body, {"content_hash": hashlib.sha256(content).hexdigest(), "byte_length": len(content)})
                    challenge = test.challenge(content)
                    challenge["challenge_id"] = f"{len(challenges):032x}"
                    challenges.append(challenge)
                    response, status = challenge, 200
                else:
                    test.assertEqual(self.path, "/api/paste")
                    submissions.append(body)
                    test.assertEqual(gzip.decompress(base64.b64decode(body["content_gzip"])), content)
                    test.assertEqual(body["compression"], "gzip")
                    test.assertEqual(body["challenge"], challenges[-1])
                    test.assertIs(body["consent"], True)
                    test.assertIs(body["consent_moderation"], True)
                    test.assertIs(body["unlisted"], True)
                    test.assertEqual(body["content_type"], "markdown")
                    test.assertEqual(body["description"], "test paste")
                    test.assertEqual(body["filename"], "note.md")
                    challenge = body["challenge"]
                    digest = hashlib.sha256(
                        f'{challenge["content_hash"]}:{challenge["challenge_id"]}:{challenge["nonce"]}:{body["solution"]}'.encode()
                    ).hexdigest()
                    test.assertEqual(body["pow_hash"], digest)
                    test.assertLess(int(digest, 16), 1 << (256 - challenge["difficulty"]))
                    if rejection and len(submissions) == 1:
                        response, status = {"error": "proof rejected"}, rejection
                    else:
                        response, status = {
                            "url": "https://cp.codes/CPTEST", "deletion_token": "secret",
                            "moderation": {"visibility": "hidden"},
                        }, 201
                data = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "note.md"
                path.write_bytes(content)
                argv = ["-" if stdin else str(path), "--consent", "--consent-moderation", "--unlisted", "--json",
                        "--content-type", "markdown", "--description", "test paste",
                        "--base-url", f"http://127.0.0.1:{server.server_port}"]
                if stdin:
                    argv.extend(["--filename", "note.md"])
                stdout, stderr = io.StringIO(), io.StringIO()
                input_stream = io.TextIOWrapper(io.BytesIO(content), encoding="utf-8")
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(paste.sys, "stdin", input_stream):
                    code = paste.main(argv)
                if rejection == 400:
                    self.assertEqual(code, 1)
                    self.assertIn("HTTP 400: proof rejected", stderr.getvalue())
                else:
                    self.assertEqual(code, 0, stderr.getvalue())
                    self.assertEqual(json.loads(stdout.getvalue())["deletion_token"], "secret")
                    self.assertIn("hidden pending moderation", stderr.getvalue())
                expected = 2 if rejection in (403, 409) else 1
                self.assertEqual(len(challenges), expected)
                self.assertEqual(len(submissions), expected)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_file_upload(self):
        self.run_upload()

    def test_stdin_upload(self):
        self.run_upload(stdin=True)

    def test_retry_rejected_proof(self):
        for status in (403, 409):
            with self.subTest(status=status):
                self.run_upload(rejection=status)

    def test_no_retry_other_errors(self):
        self.run_upload(rejection=400)

    def test_both_consents_required(self):
        for argv in ([], ["--consent"], ["--consent-moderation"]):
            with self.subTest(argv=argv), patch.object(paste, "post_json") as request:
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exc:
                    paste.main(argv)
                self.assertEqual(exc.exception.code, 2)
                request.assert_not_called()

    def test_invalid_text_rejected_before_network(self):
        for content in (b"", b"\xff", b"a\x00b"):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "input.txt"
                path.write_bytes(content)
                with patch.object(paste, "post_json") as request, redirect_stderr(io.StringIO()):
                    self.assertEqual(paste.main([str(path), "--consent", "--consent-moderation"]), 1)
                    request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
