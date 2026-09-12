#!/usr/bin/env -S uv run --exclude-newer 2026-02-01 --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
# ]
# ///
import time
import threading
import typing as typ
import datetime as dt


# ID Format layout:
#
# 9-character ID = `CP` + 7-character Base32 (35 bit) payload:
#
# - version: 5 bits — `0..31` (format version; currently 0)
# - timestamp: 20 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
# - counter: 7 bits — per-tick sequence `0..127`
# - region ID: 3 bits — `0..7`
#
# Layout: [version:5][timestamp:20][counter:7][region:3]
#
# At 300s resolution, 20-bit ticks cover ~10 years


class CPCode(typ.NamedTuple):
    version: int
    timestamp: float
    counter: int
    region_id: int


ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ"
VERSION_BITS = 5
TIMESTAMP_BITS = 20
COUNTER_BITS = 7
REGION_ID_BITS = 3

PAYLOAD_BITS = VERSION_BITS + TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS
PAYLOAD_CHARS = 7  # 35 bits → 7 Base32 chars
ID_PREFIX = "CP"
ID_LENGTH = len(ID_PREFIX) + PAYLOAD_CHARS  # 9

CURRENT_VERSION = 0
TIME_EPOCH = 1_785_000_000
TIME_RESOLUTION = 300
MAX_TICK = 1 << TIMESTAMP_BITS
MAX_COUNTER = 1 << COUNTER_BITS

_last_timestamp = 0.0
_last_counter = -1
_last_lock = threading.Lock()


def timestamp_to_tick(timestamp: float) -> int:
    return round((timestamp - TIME_EPOCH) / TIME_RESOLUTION)


def tick_to_timestamp(tick: int) -> float:
    return TIME_EPOCH + tick * TIME_RESOLUTION


def align_timestamp(timestamp: float) -> float:
    return tick_to_timestamp(timestamp_to_tick(timestamp))


def next_parts(
    last_ts: float = 0.0,
    last_counter: int = -1,
    now: float | None = None,
) -> tuple[float, int]:
    """Next monotonic (timestamp, counter) on the TIME_RESOLUTION grid."""
    if now is None:
        now = time.time()
    # floor wall-clock so we never issue a tick still in the future
    now_tick = int((now - TIME_EPOCH) / TIME_RESOLUTION)
    if last_ts <= 0:
        tick = now_tick
        counter = 0
    else:
        last_tick = timestamp_to_tick(last_ts)
        if now_tick > last_tick:
            tick = now_tick
            counter = 0
        else:
            tick = last_tick
            counter = last_counter + 1
            if counter >= MAX_COUNTER:
                counter = 0
                tick = last_tick + 1
    if not 0 <= tick < MAX_TICK:
        raise ValueError("timestamp is outside the supported range")
    return tick_to_timestamp(tick), counter


def encode_cp_code(cp_code: CPCode) -> str:
    if not 0 <= cp_code.version < (1 << VERSION_BITS):
        raise ValueError(f"version must be between 0 and {(1 << VERSION_BITS) - 1}")
    if cp_code.version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {cp_code.version}")
    if not 0 <= cp_code.counter < MAX_COUNTER:
        raise ValueError(f"counter must be between 0 and {MAX_COUNTER - 1}")
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

    # [version:5][timestamp:20][counter:7][region:3] = 35 bits
    payload = (
        (cp_code.version << (TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS))
        | (ts_val << (COUNTER_BITS + REGION_ID_BITS))
        | (cp_code.counter << REGION_ID_BITS)
        | cp_code.region_id
    )

    chars = []
    for _ in range(PAYLOAD_CHARS):
        chars.append(ALPHABET[payload & 0x1F])
        payload >>= 5
    return ID_PREFIX + "".join(reversed(chars))


def generate_cp_code(
    region_id: int = 0,
    timestamp: float | None = None,
    counter: int | None = None,
    version: int = CURRENT_VERSION,
) -> CPCode:
    global _last_timestamp, _last_counter

    if not 0 <= version < (1 << VERSION_BITS):
        raise ValueError(f"version must be between 0 and {(1 << VERSION_BITS) - 1}")
    if version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {version}")
    if not 0 <= region_id < (1 << REGION_ID_BITS):
        raise ValueError(f"region_id must be between 0 and {(1 << REGION_ID_BITS) - 1}")

    if timestamp is None:
        if counter is not None:
            raise ValueError("counter requires an explicit timestamp")
        with _last_lock:
            ts, ctr = next_parts(_last_timestamp, _last_counter)
            _last_timestamp = ts
            _last_counter = ctr
    else:
        ts = align_timestamp(timestamp)
        tick = timestamp_to_tick(ts)
        if not 0 <= tick < MAX_TICK:
            raise ValueError("timestamp is outside the supported range")
        ctr = 0 if counter is None else counter
        if not 0 <= ctr < MAX_COUNTER:
            raise ValueError(f"counter must be between 0 and {MAX_COUNTER - 1}")

    return CPCode(version, ts, ctr, region_id)


def make_cp_code(*args, **kwargs) -> str:
    return encode_cp_code(generate_cp_code(*args, **kwargs))


def parse_cp_code(cp_code_data: str) -> CPCode:
    if not isinstance(cp_code_data, str) or len(cp_code_data) != ID_LENGTH:
        raise ValueError(f"ID must be exactly {ID_LENGTH} characters")

    if not cp_code_data.startswith(ID_PREFIX):
        raise ValueError(f"ID must use prefix {ID_PREFIX!r}")

    payload = 0
    for char in cp_code_data[len(ID_PREFIX) :].upper():
        try:
            digit = ALPHABET.index(char)
        except ValueError:
            raise ValueError(f"invalid Base32 character: {char!r}") from None
        payload = (payload << 5) | digit

    # [version:5][timestamp:20][counter:7][region:3]
    version = (payload >> (TIMESTAMP_BITS + COUNTER_BITS + REGION_ID_BITS)) & (
        (1 << VERSION_BITS) - 1
    )
    ts_val = (payload >> (COUNTER_BITS + REGION_ID_BITS)) & ((1 << TIMESTAMP_BITS) - 1)
    counter = (payload >> REGION_ID_BITS) & ((1 << COUNTER_BITS) - 1)
    region_id = payload & ((1 << REGION_ID_BITS) - 1)

    if version != CURRENT_VERSION:
        raise ValueError(f"unsupported version: {version}")

    return CPCode(version, tick_to_timestamp(ts_val), counter, region_id)


def main() -> None:
    end = TIME_EPOCH + MAX_TICK * TIME_RESOLUTION
    start_date = dt.datetime.fromtimestamp(TIME_EPOCH, tz=dt.timezone.utc)
    end_date = dt.datetime.fromtimestamp(end, tz=dt.timezone.utc)
    duration_s = MAX_TICK * TIME_RESOLUTION
    print(
        f"version {CURRENT_VERSION}: origin={TIME_EPOCH} ({start_date.date()}) "
        f"end={int(end)} ({end_date.date()}) "
        f"resolution={TIME_RESOLUTION}s "
        f"duration={duration_s}s ({duration_s / 86400:.1f} days, {duration_s / 31557600:.2f} years) "
        f"id_length={ID_LENGTH} payload_bits={PAYLOAD_BITS}"
    )

    prev_data = None
    for _ in range(4):
        cp_code = generate_cp_code(region_id=0)
        cp_code_data = encode_cp_code(cp_code)
        print(cp_code_data, cp_code)
        assert parse_cp_code(cp_code_data) == cp_code
        assert len(cp_code_data) == ID_LENGTH

        if prev_data is not None:
            assert cp_code_data > prev_data
        prev_data = cp_code_data


if __name__ == "__main__":
    main()
