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
# The version is identified by the total ID length, not stored in the payload.
#
# 8-character ID = `CP` + 6-character Base32 (30 bit) payload:
#
# - timestamp: 24 bits — ticks since start of epoch
# - counter: 4 bits — per-tick sequence number
# - region ID: 2 bits
#
# Layout: [timestamp:24][counter:4][region:2]

# 9-character ID = `CP` + 7-character Base32 (35 bit) payload:
#
# - timestamp: 24 bits — ticks since TIME_EPOCH at TIME_RESOLUTION
# - counter: 9 bits — per-tick sequence number
# - region ID: 2 bits
#
# Layout: [timestamp:24][counter:9][region:2]
#
# At 5 minute resolution, the 24-bit timestamp wraps around after ~160 years
# Regions: enam=0, weur=1, apac=2, sam=3


class CPCode(typ.NamedTuple):
    timestamp: int
    counter: int
    region_id: int
    version: int


ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ"
ID_PREFIX = "CP"
TIMESTAMP_BITS = 24
REGION_ID_BITS = 2
V0_COUNTER_BITS = 4
V1_COUNTER_BITS = 9

VERSION_0 = 0  # id length=8 (payload=6)
VERSION_1 = 1  # id length=9 (payload=7)
CURRENT_VERSION = VERSION_0

COUNTER_BITS_BY_VERSION = {
    VERSION_0: V0_COUNTER_BITS,
    VERSION_1: V1_COUNTER_BITS,
}
assert all(
    (TIMESTAMP_BITS + counter_bits + REGION_ID_BITS) % 5 == 0
    for counter_bits in COUNTER_BITS_BY_VERSION.values()
)

PAYLOAD_CHARS_BY_VERSION = {
    version: (TIMESTAMP_BITS + counter_bits + REGION_ID_BITS) // 5
    for version, counter_bits in COUNTER_BITS_BY_VERSION.items()
}
ID_LENGTH_BY_VERSION = {
    version: len(ID_PREFIX) + payload_chars
    for version, payload_chars in PAYLOAD_CHARS_BY_VERSION.items()
}
VERSION_BY_ID_LENGTH = {
    id_length: version for version, id_length in ID_LENGTH_BY_VERSION.items()
}

assert ID_LENGTH_BY_VERSION == {VERSION_0: 8, VERSION_1: 9}

# Aliases for the default format.
PAYLOAD_CHARS = PAYLOAD_CHARS_BY_VERSION[CURRENT_VERSION]
PAYLOAD_BITS = PAYLOAD_CHARS * 5
ID_LENGTH = ID_LENGTH_BY_VERSION[CURRENT_VERSION]

TIME_EPOCH = 1_785_000_000
TIME_RESOLUTION = 5 * 60
MAX_TICK = 1 << TIMESTAMP_BITS
V0_MAX_COUNTER = 1 << V0_COUNTER_BITS
V1_MAX_COUNTER = 1 << V1_COUNTER_BITS

_last_parts = {
    VERSION_0: (0, -1),
    VERSION_1: (0, -1),
}
_last_lock = threading.Lock()


def timestamp_to_tick(timestamp: int | float) -> int:
    return round((timestamp - TIME_EPOCH) / TIME_RESOLUTION)


def tick_to_timestamp(tick: int) -> int:
    return TIME_EPOCH + tick * TIME_RESOLUTION


def align_timestamp(timestamp: int | float) -> int:
    return tick_to_timestamp(timestamp_to_tick(timestamp))


def next_parts(
    last_ts: float = 0.0,
    last_counter: int = -1,
    now: float | None = None,
    max_counter: int = V0_MAX_COUNTER,
) -> tuple[int, int]:
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
            if counter >= max_counter:
                counter = 0
                tick = last_tick + 1
    if not 0 <= tick < MAX_TICK:
        raise ValueError("timestamp is outside the supported range")
    return tick_to_timestamp(tick), counter


def encode_cp_code(cp_code: CPCode) -> str:
    try:
        counter_bits = COUNTER_BITS_BY_VERSION[cp_code.version]
    except KeyError:
        raise ValueError(f"unsupported version: {cp_code.version}") from None

    max_counter = 1 << counter_bits
    if not 0 <= cp_code.counter < max_counter:
        raise ValueError(f"counter must be between 0 and {max_counter - 1}")
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

    payload = (
        (ts_val << (counter_bits + REGION_ID_BITS))
        | (cp_code.counter << REGION_ID_BITS)
        | cp_code.region_id
    )

    chars = []
    for _ in range(PAYLOAD_CHARS_BY_VERSION[cp_code.version]):
        chars.append(ALPHABET[payload & 0x1F])
        payload >>= 5
    return ID_PREFIX + "".join(reversed(chars))


def generate_cp_code(
    region_id: int = 0,
    timestamp: int | float | None = None,
    counter: int | None = None,
    version: int = CURRENT_VERSION,
) -> CPCode:
    try:
        counter_bits = COUNTER_BITS_BY_VERSION[version]
    except KeyError:
        raise ValueError(f"unsupported version: {version}") from None

    max_counter = 1 << counter_bits
    if not 0 <= region_id < (1 << REGION_ID_BITS):
        raise ValueError(f"region_id must be between 0 and {(1 << REGION_ID_BITS) - 1}")

    if timestamp is None:
        if counter is not None:
            raise ValueError("counter requires an explicit timestamp")

        with _last_lock:
            last_ts, last_counter = _last_parts[version]
            ts, ctr = next_parts(last_ts, last_counter, max_counter=max_counter)
            _last_parts[version] = (ts, ctr)
    else:
        ts = align_timestamp(timestamp)
        tick = timestamp_to_tick(ts)

        if not 0 <= tick < MAX_TICK:
            raise ValueError("timestamp is outside the supported range")
        ctr = 0 if counter is None else counter
        if not 0 <= ctr < max_counter:
            raise ValueError(f"counter must be between 0 and {max_counter - 1}")

    return CPCode(ts, ctr, region_id, version)


def make_cp_code(*args, **kwargs) -> str:
    return encode_cp_code(generate_cp_code(*args, **kwargs))


def parse_cp_code(cp_code_data: str) -> CPCode:
    if not isinstance(cp_code_data, str) or len(cp_code_data) not in VERSION_BY_ID_LENGTH:
        lengths = " or ".join(str(length) for length in sorted(VERSION_BY_ID_LENGTH))
        raise ValueError(f"ID must be exactly {lengths} characters")

    if not cp_code_data.startswith(ID_PREFIX):
        raise ValueError(f"ID must use prefix {ID_PREFIX!r}")

    version = VERSION_BY_ID_LENGTH[len(cp_code_data)]
    counter_bits = COUNTER_BITS_BY_VERSION[version]
    payload = 0
    for char in cp_code_data[len(ID_PREFIX) :].upper():
        try:
            digit = ALPHABET.index(char)
        except ValueError:
            raise ValueError(f"invalid Base32 character: {char!r}") from None
        payload = (payload << 5) | digit

    ts_val = (payload >> (counter_bits + REGION_ID_BITS)) & ((1 << TIMESTAMP_BITS) - 1)
    counter = (payload >> REGION_ID_BITS) & ((1 << counter_bits) - 1)
    region_id = payload & ((1 << REGION_ID_BITS) - 1)

    return CPCode(tick_to_timestamp(ts_val), counter, region_id, version)


def main() -> None:
    end = TIME_EPOCH + MAX_TICK * TIME_RESOLUTION
    start_date = dt.datetime.fromtimestamp(TIME_EPOCH, tz=dt.timezone.utc)
    end_date = dt.datetime.fromtimestamp(end, tz=dt.timezone.utc)
    duration_s = MAX_TICK * TIME_RESOLUTION
    print(
        f"epoch_duration={MAX_TICK} ticks * {TIME_RESOLUTION}s = {duration_s}s "
        f"({duration_s / 31557600:.2f} years)"
    )

    for version in COUNTER_BITS_BY_VERSION:
        counter_bits = COUNTER_BITS_BY_VERSION[version]
        id_length = ID_LENGTH_BY_VERSION[version]
        payload_bits = PAYLOAD_CHARS_BY_VERSION[version] * 5
        print()
        print(
            f"version {version}: origin={TIME_EPOCH} ({start_date.date()}) "
            f"end={end} ({end_date.date()}) "
            f"resolution={TIME_RESOLUTION}s "
            f"counter_bits={counter_bits} "
            f"id_length={id_length} payload_bits={payload_bits}"
        )

        prev_data = None
        for _ in range(4):
            cp_code = generate_cp_code(region_id=0, version=version)
            cp_code_data = encode_cp_code(cp_code)
            print(cp_code_data, cp_code)
            assert parse_cp_code(cp_code_data) == cp_code
            assert len(cp_code_data) == id_length

            if prev_data is not None:
                assert cp_code_data > prev_data
            prev_data = cp_code_data


if __name__ == "__main__":
    main()
