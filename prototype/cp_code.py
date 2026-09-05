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
# 10-character Base32 (50 bit) ID format:
#
# - epoch: 8 bits — `0..255`
# - timestamp: 30 bits
# - region ID 8 bits — `0..255`
# - checksum: 4 bits — detects random corruption with probability >90%


class CPCode(typ.NamedTuple):
    epoch: int
    timestamp: float
    region_id: int


ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ"
EPOCH_BITS = 8
TIMESTAMP_BITS = 30
REGION_ID_BITS = 8
CHECKSUM_BITS = 4


class Epoch(typ.NamedTuple):
    eid: int
    start: float
    resolution: int | float


# We can have new epochs overlap with previous, and still
# maintain chronological sort order, so long as we're sure
# that all code was changed (and therefore no ids were issued)
# before the start of the new epoch
EPOCHS = {0: Epoch(eid=0, start=1_785_000_000, resolution=0.1)}

EPOCHS[1] = Epoch(
    eid=1,
    start=int(EPOCHS[0].start + 2**TIMESTAMP_BITS * EPOCHS[0].resolution),
    resolution=0.1,
)

EPOCHS[2] = Epoch(
    eid=2,
    start=int(EPOCHS[1].start + 2**TIMESTAMP_BITS * EPOCHS[1].resolution),
    resolution=0.1,
)

_last_timestamp = 0
_last_timestamp_lock = threading.Lock()


def _get_epoch(epoch_id: int) -> Epoch:
    try:
        return EPOCHS[epoch_id]
    except KeyError:
        raise ValueError(f"unknown epoch: {epoch_id}") from None


def _epoch_for_timestamp(timestamp: float) -> Epoch:
    for epoch_id, epoch in sorted(EPOCHS.items(), reverse=True):
        if epoch.start <= timestamp < epoch.start + (1 << TIMESTAMP_BITS) * epoch.resolution:
            return epoch

    raise ValueError("timestamp is outside the supported epoch ranges")


def encode_cp_code(cp_code: CPCode) -> str:
    epoch = _get_epoch(cp_code.epoch)
    offset = cp_code.timestamp - epoch.start
    if offset < 0:
        raise ValueError("timestamp is outside the selected epoch or is not aligned")

    # Use rounding so float resolutions like 0.1 survive binary float noise.
    ts_val = round(offset / epoch.resolution)
    if abs(offset - ts_val * epoch.resolution) > 1e-6:
        raise ValueError("timestamp is outside the selected epoch or is not aligned")
    if not 0 <= ts_val < (1 << TIMESTAMP_BITS):
        raise ValueError("timestamp is outside the supported range")
    if not 0 <= cp_code.region_id < (1 << REGION_ID_BITS):
        raise ValueError("region_id must be between 0 and 255")

    # [epoch:8][timestamp:30][region:8] + [checksum:4] = 50 bits (10 Base32 chars)
    payload = (
        (cp_code.epoch << (TIMESTAMP_BITS + REGION_ID_BITS))
        | (ts_val << REGION_ID_BITS)
        | cp_code.region_id
    )
    payload_bytes = payload.to_bytes(6, "big")
    checksum = zlib.crc32(payload_bytes) & ((1 << CHECKSUM_BITS) - 1)
    value = (payload << CHECKSUM_BITS) | checksum

    chars = []
    for _ in range(10):
        chars.append(ALPHABET[value & 0x1F])
        value >>= 5
    return "CP" + "".join(reversed(chars))


def generate_cp_code(region_id: int = 0) -> CPCode:
    global _last_timestamp

    if not 0 <= region_id < (1 << REGION_ID_BITS):
        raise ValueError("region_id must be between 0 and 255")

    now = time.time()
    epoch = _epoch_for_timestamp(now)
    # Align down to epoch resolution (tick math avoids float modulo noise).
    ts_val = int((now - epoch.start) / epoch.resolution)
    timestamp = epoch.start + ts_val * epoch.resolution

    with _last_timestamp_lock:
        if timestamp <= _last_timestamp:
            ts_val = round((_last_timestamp - epoch.start) / epoch.resolution) + 1
            timestamp = epoch.start + ts_val * epoch.resolution
        _last_timestamp = timestamp

    return CPCode(epoch.eid, timestamp, region_id)


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

    checksum = value & ((1 << CHECKSUM_BITS) - 1)
    payload = value >> CHECKSUM_BITS
    expected_checksum = zlib.crc32(payload.to_bytes(6, "big")) & ((1 << CHECKSUM_BITS) - 1)

    if checksum != expected_checksum:
        raise ValueError("invalid checksum")

    # [epoch:8][timestamp:30][region:8]
    epoch_id = (payload >> (TIMESTAMP_BITS + REGION_ID_BITS)) & ((1 << EPOCH_BITS) - 1)
    ts_val = (payload >> REGION_ID_BITS) & ((1 << TIMESTAMP_BITS) - 1)
    region_id = payload & ((1 << REGION_ID_BITS) - 1)

    epoch = _get_epoch(epoch_id)
    timestamp = epoch.start + ts_val * epoch.resolution
    return CPCode(epoch_id, timestamp, region_id)


def main() -> None:
    for epoch in EPOCHS.values():
        duration_s = (1 << TIMESTAMP_BITS) * epoch.resolution
        end = int(epoch.start + duration_s)
        start_date = datetime.fromtimestamp(epoch.start, tz=timezone.utc)
        end_date = datetime.fromtimestamp(end, tz=timezone.utc)
        print(
            f"epoch {epoch.eid}: start={epoch.start} ({start_date.date()}) "
            f"end={end} ({end_date.date()}) "
            f"resolution={epoch.resolution}s "
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
