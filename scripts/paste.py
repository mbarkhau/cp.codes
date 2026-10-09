#!/usr/bin/env -S uv run --script
"""Publish UTF-8 content to cp.codes using its signed SHA-256 PoW API.

Requires Python 3.9+; uses only the standard library.
"""

import argparse
import base64
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


CONTENT_TYPES = (
    "plaintext", "url", "markdown", "png", "jpeg", "javascript", "typescript",
    "python", "java", "json", "html", "css", "shell", "sql", "yaml", "xml",
    "c", "cpp", "csharp", "go", "rust", "ruby", "php",
)


class ApiError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")


class ProofExpired(RuntimeError):
    pass


def post_json(base_url, path, payload, timeout):
    request = Request(
        base_url + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except HTTPError as exc:
        raw = exc.read()
        try:
            body = json.loads(raw)
            message = body.get("error", exc.reason) if isinstance(body, dict) else exc.reason
        except (ValueError, UnicodeError):
            message = raw.decode("utf-8", errors="replace")[:500] or exc.reason
        raise ApiError(exc.code, message) from exc
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError(f"{path}: server returned invalid JSON") from exc
    if not isinstance(body, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return body


def validate_challenge(challenge, content_hash, byte_length):
    if challenge.get("version") != 1 or challenge.get("algorithm") != "sha256":
        raise RuntimeError("server returned an unsupported PoW challenge")
    if challenge.get("content_hash") != content_hash or challenge.get("byte_length") != byte_length:
        raise RuntimeError("challenge is not bound to the submitted content")
    for field in ("challenge_id", "nonce"):
        if not isinstance(challenge.get(field), str) or not re.fullmatch(r"[0-9a-f]{32}", challenge[field]):
            raise RuntimeError(f"invalid challenge {field}")
    difficulty = challenge.get("difficulty")
    if type(difficulty) is not int or not 0 <= difficulty <= 256:
        raise RuntimeError("invalid challenge difficulty")
    if not isinstance(challenge.get("signature"), str) or not challenge["signature"]:
        raise RuntimeError("server returned an unsigned challenge")
    if type(challenge.get("expires_at")) is not int:
        raise RuntimeError("invalid challenge expiry")


def solve_pow(challenge, timeout):
    """Search decimal counters; compare the digest as an MSB-first integer."""
    remaining = challenge["expires_at"] / 1000 - time.time()
    if remaining <= 0:
        raise ProofExpired("challenge expired before proof search")
    expires = time.monotonic() + remaining
    deadline = time.monotonic() + timeout
    threshold = 1 << (256 - challenge["difficulty"])
    prefix = (
        f'{challenge["content_hash"].lower()}:{challenge["challenge_id"].lower()}:'
        f'{challenge["nonce"].lower()}:'
    ).encode("ascii")
    # Reuse the prefix's SHA-256 state rather than hashing it on every attempt.
    initial = hashlib.sha256(prefix)
    counter = 0
    while True:
        if counter % 1024 == 0:
            now = time.monotonic()
            if now >= expires:
                raise ProofExpired("challenge expired during proof search")
            if now >= deadline:
                raise RuntimeError("PoW search timed out; increase --pow-timeout or try again later")
        solution = str(counter)
        digest = initial.copy()
        digest.update(solution.encode("ascii"))
        result = digest.digest()
        if int.from_bytes(result, "big") < threshold:
            return solution, result.hex()
        counter += 1


def publish(args, content):
    content_hash = hashlib.sha256(content).hexdigest()
    payload = {
        "content_gzip": base64.b64encode(gzip.compress(content, mtime=0)).decode("ascii"),
        "compression": "gzip",
        "content_type": args.content_type,
        "description": args.description,
        "filename": args.filename,
        "unlisted": args.unlisted,
        "consent": args.consent,
        "consent_moderation": args.consent_moderation,
    }
    for attempt in range(2):
        challenge = post_json(args.base_url, "/api/challenge", {
            "content_hash": content_hash, "byte_length": len(content),
        }, args.timeout)
        validate_challenge(challenge, content_hash, len(content))
        print(f'Solving SHA-256 PoW ({challenge["difficulty"]} leading zero bits)…', file=sys.stderr)
        try:
            solution, pow_hash = solve_pow(challenge, args.pow_timeout)
            # Return the signed challenge unchanged; clients cannot authenticate its HMAC.
            return post_json(args.base_url, "/api/paste", {
                **payload, "challenge": challenge, "solution": solution, "pow_hash": pow_hash,
            }, args.timeout)
        except (ProofExpired, ApiError) as exc:
            if attempt == 1 or (isinstance(exc, ApiError) and exc.status not in (403, 409)):
                raise
            print("Proof expired or rejected; requesting one fresh challenge…", file=sys.stderr)
    raise RuntimeError("upload failed")


def positive_seconds(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?", default="-", help="UTF-8 file to paste (default: stdin; '-' also means stdin)")
    parser.add_argument("--base-url", default="https://cp.codes", help="service origin (default: https://cp.codes)")
    parser.add_argument("--content-type", choices=CONTENT_TYPES, default="plaintext", help="resolved content type (default: plaintext)")
    parser.add_argument("--description", default="", help="optional public description")
    parser.add_argument("--filename", help="public filename (default: input file's basename)")
    parser.add_argument("--unlisted", action="store_true", help="omit from recent uploads; NOT private")
    parser.add_argument("--consent", action="store_true", required=True, help="consent to collecting and storing your IP and location with this upload")
    parser.add_argument("--consent-moderation", action="store_true", required=True, help="consent to sending paste text, description, and filename to DefAPI/TypeSafe for automated moderation")
    parser.add_argument("--json", action="store_true", help="print full API response, including the deletion token")
    parser.add_argument("--timeout", type=positive_seconds, default=60, help="HTTP timeout in seconds (default: 60)")
    parser.add_argument("--pow-timeout", type=positive_seconds, default=120, help="proof search timeout in seconds per challenge (default: 120)")
    args = parser.parse_args(argv)
    args.base_url = args.base_url.rstrip("/")
    origin = urlsplit(args.base_url)
    if origin.scheme not in ("http", "https") or not origin.netloc or origin.path or origin.query or origin.fragment or origin.username:
        parser.error("--base-url must be an HTTP(S) origin, e.g. http://localhost:8787")
    try:
        content = sys.stdin.buffer.read() if args.file == "-" else Path(args.file).read_bytes()
        content.decode("utf-8", errors="strict")
        if not content or b"\x00" in content:
            raise ValueError("content must be non-empty UTF-8 text without NUL bytes")
        if args.filename is None and args.file != "-":
            args.filename = Path(args.file).name
        result = publish(args, content)
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(result["url"])
            if result.get("deletion_token"):
                print(f'Deletion token (valid for 10 minutes): {result["deletion_token"]}', file=sys.stderr)
        if result.get("moderation", {}).get("visibility") == "hidden":
            print("Stored, but hidden pending moderation review; the URL is not public yet.", file=sys.stderr)
        return 0
    except (OSError, ValueError, RuntimeError, URLError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
