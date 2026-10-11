#!/usr/bin/env -S uv run --script
"""Publish text or binary files to cp.codes using its signed SHA-256 PoW API.

Binary files are stored as base64 data URLs; images and MP3/MP4 media play in the viewer.

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
    "plaintext", "url", "markdown", "png", "jpeg", "webp", "gif", "mp3", "mp4", "javascript", "typescript",
    "python", "java", "json", "html", "css", "shell", "sql", "yaml", "xml",
    "c", "cpp", "csharp", "go", "rust", "ruby", "php",
)


MEDIA_MIME_TYPES = {
    "png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif",
    "mp3": "audio/mpeg", "mp4": "video/mp4",
}
MP4_BRANDS = {
    b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"iso7", b"iso8", b"iso9",
    b"mp41", b"mp42", b"avc1", b"M4V ", b"M4A ", b"MSNV", b"dash", b"msdh", b"msix",
}


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
    if type(challenge.get("version")) is not int or challenge.get("version") not in (1, 2) or challenge.get("algorithm") != "sha256":
        raise RuntimeError("server returned an unsupported PoW challenge")
    if challenge.get("content_hash") != content_hash or challenge.get("byte_length") != byte_length:
        raise RuntimeError("challenge is not bound to the submitted content")
    for field in ("challenge_id", "nonce"):
        if not isinstance(challenge.get(field), str) or not re.fullmatch(r"[0-9a-f]{32}", challenge[field]):
            raise RuntimeError(f"invalid challenge {field}")
    if challenge.get('version') == 2 and not re.fullmatch(r'[0-9a-f]{64}', str(challenge.get('requester_hash', ''))):
        raise RuntimeError('invalid challenge requester_hash')
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


def image_type(content):
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(content) >= 4 and content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9"):
        return "jpeg"
    if (len(content) >= 20 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
            and content[12:16] in (b"VP8 ", b"VP8L", b"VP8X")
            and int.from_bytes(content[4:8], "little") + 8 == len(content)):
        return "webp"
    if len(content) >= 14 and content[:6] in (b"GIF87a", b"GIF89a") and content.endswith(b";"):
        return "gif"
    return None


def media_type(content):
    detected_image = image_type(content)
    if detected_image:
        return detected_image
    if (len(content) >= 10 and content[:3] == b"ID3" and content[3] in (2, 3, 4)
            and content[4] != 0xff and all(byte < 0x80 for byte in content[6:10])):
        return "mp3"
    if (len(content) >= 4 and content[0] == 0xff and content[1] & 0xe0 == 0xe0
            and content[1] & 0x18 != 0x08 and content[1] & 0x06 == 0x02
            and content[2] & 0xf0 != 0xf0 and content[2] & 0x0c != 0x0c):
        return "mp3"
    if len(content) >= 16 and content[4:8] == b"ftyp":
        size = int.from_bytes(content[:4], "big")
        if 16 <= size <= len(content) and size % 4 == 0 and content[8:12] in MP4_BRANDS:
            return "mp4"
    return None


def prepare_content(content, content_type="plaintext", force_binary=False):
    """Return the UTF-8 body and resolved type before hashing or compression."""
    if not content:
        raise ValueError("content must be non-empty")
    detected_media = media_type(content)
    if detected_media:
        if content_type not in ("plaintext", detected_media):
            raise ValueError(f"binary media is {detected_media}, not {content_type}")
        prefix = f"data:{MEDIA_MIME_TYPES[detected_media]};base64,".encode("ascii")
        return prefix + base64.b64encode(content), detected_media

    try:
        text = content.decode("utf-8", errors="strict")
        binary = b"\x00" in content or sum(
            byte < 0x20 and byte not in (9, 10, 13) or byte == 0x7f
            for byte in content[:4096]
        ) > 8
    except UnicodeDecodeError:
        text = None
        binary = True

    if binary or force_binary:
        if content_type != "plaintext":
            raise ValueError("unsupported binary formats require --content-type plaintext")
        return b"data:application/octet-stream;base64," + base64.b64encode(content), "plaintext"

    if content_type in MEDIA_MIME_TYPES:
        match = re.fullmatch(r"data:(image/(?:png|jpeg|webp|gif)|audio/mpeg|video/mp4);base64,([A-Za-z0-9+/]+={0,2})", text.strip())
        valid = False
        if match and match[1] == MEDIA_MIME_TYPES[content_type]:
            try:
                valid = media_type(base64.b64decode(match[2], validate=True)) == content_type
            except ValueError:
                pass
        if not valid:
            raise ValueError(f"content is not signature-checked {content_type.upper()} media or a data URL")
    return content, content_type


def publish(args, content):
    if len(content) > 8 * 1024 * 1024:
        raise ValueError('upload exceeds the 8 MiB limit (after binary encoding)')
    content_hash = hashlib.sha256(content).hexdigest()
    payload = {
        "content_gzip": base64.b64encode(gzip.compress(content, mtime=0)).decode("ascii"),
        "compression": "gzip",
        "content_type": args.content_type,
        "filename": args.filename,
        "unlisted": args.unlisted,
        "consent": args.consent_all,
        "consent_moderation": args.consent_all,
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
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("file", nargs="?", default="-", help="text or binary file to paste (default: stdin; '-' also means stdin)")
    parser.add_argument("--base-url", default="https://cp.codes", help="service origin (default: https://cp.codes)")
    parser.add_argument("--content-type", choices=CONTENT_TYPES, default="plaintext", help="resolved content type (default: plaintext; supported binary media detected automatically)")
    parser.add_argument("--binary", action="store_true", help="force base64 data-URL encoding, even for valid UTF-8 input")
    parser.add_argument("--filename", help="public filename (default: input file's basename)")
    parser.add_argument("--unlisted", action="store_true", help="omit from recent uploads; NOT private")
    parser.add_argument("--consent-all", action="store_true", required=True, help="consent to collecting and storing your IP and location and sending paste text and filename to DefAPI/TypeSafe for automated moderation")
    parser.add_argument("--json", action="store_true", help="print full API response")
    parser.add_argument("--timeout", type=positive_seconds, default=60, help="HTTP timeout in seconds (default: 60)")
    parser.add_argument("--pow-timeout", type=positive_seconds, default=120, help="proof search timeout in seconds per challenge (default: 120)")
    args = parser.parse_args(argv)
    args.base_url = args.base_url.rstrip("/")
    origin = urlsplit(args.base_url)
    if origin.scheme not in ("http", "https") or not origin.netloc or origin.path or origin.query or origin.fragment or origin.username:
        parser.error("--base-url must be an HTTP(S) origin, e.g. http://localhost:8787")
    try:
        content = sys.stdin.buffer.read() if args.file == "-" else Path(args.file).read_bytes()
        original_length = len(content)
        content, args.content_type = prepare_content(content, args.content_type, args.binary)
        if len(content) != original_length:
            print(f"Encoded {original_length:,} binary bytes as {len(content):,} data-URL bytes.", file=sys.stderr)
        if args.filename is None and args.file != "-":
            args.filename = Path(args.file).name
        result = publish(args, content)
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(result["url"])
        if result.get("moderation", {}).get("visibility") == "hidden":
            print("Stored, but hidden pending moderation review; the URL is not public yet.", file=sys.stderr)
        elif result.get('moderation', {}).get('state') == 'limited':
            print('Ready for uploader + three other IPs; wider sharing requires human review.', file=sys.stderr)
        return 0
    except (OSError, ValueError, RuntimeError, URLError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
