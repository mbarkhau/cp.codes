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


MEDIA_FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "media.json").read_text())


class PasteTests(unittest.TestCase):
    def challenge(self, content=b"hello", difficulty=8):
        return {
            "version": 2,
            "requester_hash": 'ef' * 32,
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
            {'version': 3}, {'version': True}, {'requester_hash': 'bad'},
        ):
            challenge = {**self.challenge(content), **changes}
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                paste.validate_challenge(challenge, hashlib.sha256(content).hexdigest(), len(content))

    def run_upload(self, rejection=None, stdin=False, input_content=None, expected_content=None,
                   content_type="markdown", expected_type=None, filename="note.md", binary=False):
        # A local API verifies the actual HTTP payload and forces a fresh-challenge retry.
        input_content = "hello, café 🌍\r\n".encode("utf-8") if input_content is None else input_content
        content = input_content if expected_content is None else expected_content
        expected_type = expected_type or content_type or "plaintext"
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
                    test.assertEqual(body["content_type"], expected_type)
                    test.assertNotIn("description", body)
                    test.assertEqual(body["filename"], filename)
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
                            "url": "https://cp.codes/CPTEST",
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
                path = Path(directory) / filename
                path.write_bytes(input_content)
                argv = ["-" if stdin else str(path), "--consent-all", "--unlisted", "--json",
                        "--base-url", f"http://127.0.0.1:{server.server_port}"]
                if content_type:
                    argv.extend(["--content-type", content_type])
                if binary:
                    argv.append("--binary")
                if stdin:
                    argv.extend(["--filename", filename])
                stdout, stderr = io.StringIO(), io.StringIO()
                input_stream = io.TextIOWrapper(io.BytesIO(input_content), encoding="utf-8")
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(paste.sys, "stdin", input_stream):
                    code = paste.main(argv)
                if rejection == 400:
                    self.assertEqual(code, 1)
                    self.assertIn("HTTP 400: proof rejected", stderr.getvalue())
                else:
                    self.assertEqual(code, 0, stderr.getvalue())
                    self.assertEqual(json.loads(stdout.getvalue())["url"], "https://cp.codes/CPTEST")
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

    def test_consent_all_required(self):
        for argv in ([], ["--consent"], ["--consent-moderation"],
                     ["--consent", "--consent-moderation"],
                     ["--consent-all", "--consent"], ["--consent-all", "--consent-moderation"]):
            with self.subTest(argv=argv), patch.object(paste, "post_json") as request:
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exc:
                    paste.main(argv)
                self.assertEqual(exc.exception.code, 2)
                request.assert_not_called()

    def test_binary_file_and_stdin_upload(self):
        content = bytes(range(256))
        encoded = b"data:application/octet-stream;base64," + base64.b64encode(content)
        self.assertEqual(base64.b64decode(encoded.split(b",", 1)[1]), content)
        for stdin in (False, True):
            with self.subTest(stdin=stdin):
                self.run_upload(stdin=stdin, input_content=content, expected_content=encoded,
                                content_type=None, filename="archive.bin")

    def test_binary_image_upload(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")
        jpeg = b"\xff\xd8\xff\xe0image\x00\xff\xd9"
        webp = base64.b64decode("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA")
        gif = base64.b64decode(MEDIA_FIXTURES["gif89"])
        for image_type, content in (("png", png), ("jpeg", jpeg), ("webp", webp), ("gif", gif)):
            with self.subTest(image_type=image_type):
                encoded = f"data:image/{image_type};base64,".encode() + base64.b64encode(content)
                self.run_upload(input_content=content, expected_content=encoded,
                                content_type=None, expected_type=image_type, filename=f"image.{image_type}")

    def test_force_binary_upload(self):
        content = b"looks like text\r\n"
        encoded = b"data:application/octet-stream;base64," + base64.b64encode(content)
        self.run_upload(input_content=content, expected_content=encoded,
                        content_type=None, filename="ascii.bin", binary=True)

    def test_prepare_content(self):
        for content in (b"\xff", b"a\x00b", b"\x01" * 9):
            with self.subTest(content=content):
                encoded, content_type = paste.prepare_content(content)
                self.assertEqual(content_type, "plaintext")
                self.assertTrue(encoded.startswith(b"data:application/octet-stream;base64,"))
                self.assertEqual(base64.b64decode(encoded.split(b",", 1)[1]), content)
        text = "café\r\n".encode()
        self.assertEqual(paste.prepare_content(text, "markdown"), (text, "markdown"))
        png = b"\x89PNG\r\n\x1a\n\x00image"
        encoded, content_type = paste.prepare_content(png, "png")
        self.assertEqual(content_type, "png")
        self.assertEqual(paste.prepare_content(encoded, "png"), (encoded, "png"))

    def test_webp_variants_and_data_urls(self):
        for encoded in (
            "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
            "UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA",
            "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAgFZQOCAwAAAA0AEAnQEqAQABAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA",
        ):
            content = base64.b64decode(encoded)
            with self.subTest(chunk=content[12:16]):
                self.assertEqual(paste.image_type(content), "webp")
                data_url = b"data:image/webp;base64," + encoded.encode()
                self.assertEqual(paste.prepare_content(content, "webp"), (data_url, "webp"))
                self.assertEqual(paste.prepare_content(data_url, "webp"), (data_url, "webp"))
                self.assertIsNone(paste.image_type(content[:-1]))
                self.assertIsNone(paste.image_type(b"NOPE" + content[4:]))
                self.assertIsNone(paste.image_type(content[:12] + b"NOPE" + content[16:]))

    def test_gif_versions_and_data_urls(self):
        for name in ("gif87", "gif89"):
            content = base64.b64decode(MEDIA_FIXTURES[name])
            with self.subTest(name=name):
                self.assertEqual(paste.image_type(content), "gif")
                data_url = b"data:image/gif;base64," + MEDIA_FIXTURES[name].encode()
                self.assertEqual(paste.prepare_content(content, "gif"), (data_url, "gif"))
                self.assertEqual(paste.prepare_content(data_url, "gif"), (data_url, "gif"))
                self.assertIsNone(paste.image_type(content[:-1]))
                self.assertIsNone(paste.image_type(b"NOPE!!" + content[6:]))

    def test_audio_video_file_and_stdin_uploads(self):
        for media_type, mime in (("mp3", "audio/mpeg"), ("mp4", "video/mp4")):
            content = base64.b64decode(MEDIA_FIXTURES[media_type])
            encoded = f"data:{mime};base64,".encode() + base64.b64encode(content)
            for stdin in (False, True):
                with self.subTest(media_type=media_type, stdin=stdin):
                    self.run_upload(input_content=content, expected_content=encoded, stdin=stdin,
                                    content_type=None, expected_type=media_type, filename=f"media.{media_type}")

    def test_audio_video_signatures_and_data_urls(self):
        for media_type, mime in (("mp3", "audio/mpeg"), ("mp4", "video/mp4")):
            content = base64.b64decode(MEDIA_FIXTURES[media_type])
            encoded = f"data:{mime};base64,".encode() + base64.b64encode(content)
            self.assertEqual(paste.media_type(content), media_type)
            self.assertEqual(paste.prepare_content(content, media_type), (encoded, media_type))
            self.assertEqual(paste.prepare_content(encoded, media_type), (encoded, media_type))
        mp3 = base64.b64decode(MEDIA_FIXTURES["mp3"])
        self.assertEqual(paste.media_type(mp3[45:]), "mp3")  # Without its ID3 tag.
        mp4 = base64.b64decode(MEDIA_FIXTURES["mp4"])
        self.assertIsNone(paste.media_type(b"\xff\xff\xff\xff" + mp4[4:]))
        self.assertIsNone(paste.media_type(mp4[:8] + b"avif" + mp4[12:]))
        self.assertIsNone(paste.media_type(b"\xff\xff\xff\xff"))
        self.assertIsNone(paste.media_type(b"ID3\xff" + mp3[4:]))

    def test_invalid_content_rejected_before_network(self):
        for content, options in (
            (b"", []), (b"", ["--binary"]),
            (b"\xff", ["--content-type", "javascript"]),
            (b"\x89PNG\r\n\x1a\nimage", ["--content-type", "jpeg"]),
            (b"text", ["--binary", "--content-type", "markdown"]),
            (b"not an image", ["--content-type", "png"]),
            (b"data:image/png;base64,YWJj", ["--content-type", "png"]),
            (b"data:image/jpeg;base64,/9j/2Q=", ["--content-type", "jpeg"]),
            (b"data:image/webp;base64,YWJj", ["--content-type", "webp"]),
            (b"\x89PNG\r\n\x1a\nimage", ["--content-type", "webp"]),
            (b"data:image/gif;base64,YWJj", ["--content-type", "gif"]),
            (b"\x89PNG\r\n\x1a\nimage", ["--content-type", "gif"]),
            (b"data:audio/mpeg;base64,YWJj", ["--content-type", "mp3"]),
            (b"data:video/mp4;base64,YWJj", ["--content-type", "mp4"]),
            (base64.b64decode(MEDIA_FIXTURES["mp3"]), ["--content-type", "mp4"]),
        ):
            with self.subTest(content=content, options=options), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "input.bin"
                path.write_bytes(content)
                with patch.object(paste, "post_json") as request, redirect_stderr(io.StringIO()):
                    self.assertEqual(paste.main([str(path), "--consent-all", *options]), 1)
                    request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
