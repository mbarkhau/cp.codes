#!/usr/bin/env -S uv run --exclude-newer 2026-02-01 --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
# ]
# ///
import time
import zlib
import threading
import typing as typ
from datetime import datetime, timezone


# ID Format layout:
#
# 7-character Base32 (35 bit) ID format:
#
# - version: 4 bits — `0..15` (format version; currently 0)
# - timestamp: 20 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
# - counter: 8 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
# - region ID: 3 bits — `0..8`
#
# At 60s resolution, 20-bit ticks cover ~4 years


class CPCode(typ.NamedTuple):
    version: int
    timestamp: int
    counter: int
    region_id: int


ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ"
VERSION_BITS = 4
TIMESTAMP_BITS = 20
REGION_ID_BITS = 3
COUNTER_BITS = 8

CURRENT_VERSION = 0
TIME_EPOCH = 1_785_000_000
TIME_RESOLUTION = 60
MAX_TICK = 1 << TIMESTAMP_BITS

_last_timestamp = 0.0
_last_timestamp_lock = threading.Lock()


def timestamp_to_tick(timestamp: float) -> int:
    return round((timestamp - TIME_EPOCH) / TIME_RESOLUTION)


def tick_to_timestamp(tick: int) -> float:
    return TIME_EPOCH + tick * TIME_RESOLUTION


def align_timestamp(timestamp: float) -> float:
    return tick_to_timestamp(timestamp_to_tick(timestamp))


def next_timestamp(last: float = 0.0, now: float | None = None) -> float:
    if now is None:
        now = time.time()
    now_tick = int((now - TIME_EPOCH) / TIME_RESOLUTION)
    if last <= 0:
        tick = now_tick
    else:
        last_tick = timestamp_to_tick(last)
        tick = max(now_tick, last_tick + 1)
    if not 0 <= tick < MAX_TICK:
        raise ValueError("timestamp is outside the supported range")
    return tick_to_timestamp(tick)


def encode_cp_code(cp_code: CPCode) -> str:
    if not 0 <= cp_code.version < (1 << VERSION_BITS):
        raise ValueError(f"version must be between 0 and {(1 << VERSION_BITS) - 1}")
    if cp_code.version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {cp_code.version}")
    if not 0 <= cp_code.region_id < (1 << REGION_ID_BITS):
        raise ValueError(f"region_id must be between 0 and {(1 << REGION_ID_BITS) - 1}")

    offset = cp_code.timestamp - TIME_EPOCH
    if offset < 0:
        raise ValueError("timestamp is before TIME_EPOCH")

    ts_val = timestamp_to_tick(cp_code.timestamp)
    if abs(offset - ts_val * TIME_RESOLUTION) > 1e-6:
        raise ValueError("timestamp is not aligned to TIME_RESOLUTION")
    if not 0 <= ts_val < MAX_TICK:
        raise ValueError("timestamp is outside the supported range")

    # [version:4][timestamp:36][region:6] + [checksum:4] = 50 bits
    payload = (
        (cp_code.version << (TIMESTAMP_BITS + REGION_ID_BITS))
        | (ts_val << REGION_ID_BITS)
        | (counter_val << COUNTER_BITS)
        | cp_code.region_id
    )
    payload_bytes = payload.to_bytes(6, "big")

    chars = []
    for _ in range(10):
        chars.append(ALPHABET[payload & 0x1F])
        payload >>= 5
    return "CP" + "".join(reversed(chars))


def generate_cp_code(
    region_id: int = 0,
    timestamp: float | None = None,
    version: int = CURRENT_VERSION,
) -> CPCode:
    global _last_timestamp

    if not 0 <= version < (1 << VERSION_BITS):
        raise ValueError(f"version must be between 0 and {(1 << VERSION_BITS) - 1}")
    if version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {version}")
    if not 0 <= region_id < (1 << REGION_ID_BITS):
        raise ValueError(f"region_id must be between 0 and {(1 << REGION_ID_BITS) - 1}")

    if timestamp is None:
        with _last_timestamp_lock:
            ts = next_timestamp(_last_timestamp)
            _last_timestamp = ts
    else:
        ts = align_timestamp(timestamp)
        tick = timestamp_to_tick(ts)
        if not 0 <= tick < MAX_TICK:
            raise ValueError("timestamp is outside the supported range")

    return CPCode(version, ts, region_id)


def make_cp_code(*args, **kwargs) -> str:
    return encode_cp_code(generate_cp_code(*args, **kwargs))


def parse_cp_code(cp_code_data: str) -> CPCode:
    if not isinstance(cp_code_data, str) or len(cp_code_data) != 12:
        raise ValueError("ID must be exactly 12 characters")

    if not cp_code_data.startswith("CP"):
        raise ValueError("ID must use prefix 'CP'")

    value = 0
    for char in cp_code_data[2:].upper():
        try:
            digit = ALPHABET.index(char)
        except ValueError:
            raise ValueError(f"invalid Base32 character: {char!r}") from None
        value = (value << 5) | digit

    payload = value >> CHECKSUM_BITS

    # [version:4][timestamp:36][region:6]
    version = (payload >> (TIMESTAMP_BITS + REGION_ID_BITS)) & ((1 << VERSION_BITS) - 1)
    ts_val = (payload >> REGION_ID_BITS) & ((1 << TIMESTAMP_BITS) - 1)
    region_id = payload & ((1 << REGION_ID_BITS) - 1)

    if version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {version}")

    return CPCode(version, tick_to_timestamp(ts_val), region_id)


def main() -> None:
    end = TIME_EPOCH + MAX_TICK * TIME_RESOLUTION
    start_date = datetime.fromtimestamp(TIME_EPOCH, tz=timezone.utc)
    end_date = datetime.fromtimestamp(end, tz=timezone.utc)
    duration_s = MAX_TICK * TIME_RESOLUTION
    print(
        f"version {CURRENT_VERSION}: origin={TIME_EPOCH} ({start_date.date()}) "
        f"end={int(end)} ({end_date.date()}) "
        f"resolution={TIME_RESOLUTION}s "
        f"duration={duration_s}s ({duration_s / 86400:.1f} days, {duration_s / 31557600:.2f} years)"
    )

    prev_data = None
    for _ in range(4):
        cp_code = generate_cp_code(region_id=0)
        cp_code_data = encode_cp_code(cp_code)
        print(cp_code_data, cp_code)
        assert parse_cp_code(cp_code_data) == cp_code
        assert len(cp_code_data) == 12

        if prev_data is not None:
            assert cp_code_data > prev_data
        prev_data = cp_code_data


if __name__ == "__main__":
    main()
