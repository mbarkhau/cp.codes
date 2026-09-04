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


ALPHABET = "0123456789ABCDEFGHIJKLPQRSTUVXYZ"

class Epoch(typ.NamedTuple):
    eid: int
    start: int
    resolution: int

EPOCHS = {0: Epoch(eid=0, start=1_785_000_000, resolution=0.1)}

# We can have new epochs overlap with previous, and still
# maintain chronological sort order, so long as we're sure 
# that all code was changed (and therefore no ids were issued)
# before the start of the new epoch
EPOCHS[1] = Epoch(eid=1, start=EPOCHS[0].start + 2**24 * EPOCHS[0].resolution, resolution=10)


# ID Format layout:
#
# 10-character Base32 (50 bit) ID format:
# 
# - epoch: 8 bits — `0..255`
# - timestamp: 30 bits
# - region ID 8 bits — `0..255`
# - checksum: 4 bits — detects random corruption with probability >90%
#
# With this layout is node_id=0 is implicit

# 14-character Base32 (70 bit) ID format:
#
# - epoch: 8 bits — `0..255`
# - timestamp: 30 bits
# - region ID 8 bits — `0..255`
# - node ID: 14 bits — `0..16384`
# - checksum: 8 bits — detects random corruption with probability ~99.61%


class CPCode(typ.NamedTuple):
    epoch: int
    timestamp: int
    region_id: int
    node_id: int


_last_timestamp = 0
_last_timestamp_lock = threading.Lock()


def _get_epoch(epoch_id: int) -> Epoch:
    try:
        return EPOCHS[epoch_id]
    except KeyError:
        raise ValueError(f"unknown epoch: {epoch_id}") from None


def _epoch_for_timestamp(timestamp: int) -> Epoch:
    for epoch_id, epoch in sorted(EPOCHS.items(), reverse=True):
        if epoch.start <= timestamp < epoch.start + (1 << 24) * epoch.resolution:
            return epoch

    raise ValueError("timestamp is outside the supported epoch ranges")


def encode_cp_code(cp_code: CPCode) -> str:
    epoch = _get_epoch(cp_code.epoch)
    offset = cp_code.timestamp - epoch.start
    if offset < 0 or offset % epoch.resolution:
        raise ValueError("timestamp is outside the selected epoch or is not aligned")
    ts_val = offset // epoch.resolution
    if not 0 <= ts_val < (1 << 24):
        raise ValueError("timestamp is outside the supported range")
    if not 0 <= cp_code.counter < (1 << 10):
        raise ValueError("counter must be between 0 and 1023")

    if cp_code.node_id == 0:
        # 8-bit epoch, 24-bit timestamp, and 10-bit counter.
        payload = (cp_code.epoch << 34) | (ts_val << 10) | cp_code.counter
        payload_bytes = payload.to_bytes(6, "big")
        length = 10
    else:
        if not 0 <= cp_code.node_id < (1 << 20):
            raise ValueError("node_id must be between 0 and 1048575")
        # 8-bit epoch, 24-bit timestamp, 10-bit counter, and 20-bit node ID.
        payload = (
            (cp_code.epoch << 54)
            | (ts_val << 30)
            | (cp_code.counter << 20)
            | cp_code.node_id
        )
        payload_bytes = payload.to_bytes(8, "big")
        length = 14

    checksum = zlib.crc32(payload_bytes) & 0xFF
    value = (payload << 8) | checksum
    chars = []
    for _ in range(length):
        chars.append(ALPHABET[value & 0x1F])
        value >>= 5
    return "CP" + "".join(reversed(chars))
    

def generate_cp_code(region_id: int = 0, node_id: int = 0) -> CPCode:
    global _last_timestamp

    if not (0 <= node_id < (1 << 20)):
        raise ValueError("node_id must be between 0 and 1048575")

    now = int(time.time())
    epoch = _epoch_for_timestamp(now)
    timestamp = now - (now - epoch.start) % epoch.resolution

    with _last_timestamp_lock:
        if timestamp == _last_timestamp:
            timestamp += 1
        _last_timestamp = timestamp

    return CPCode(epoch.eid, timestamp, region_id, node_id)


def make_cp_code(*args, **kwargs) -> str:
    return encode_cp_code(generate_cp_code(*args, **kwargs))


def parse_cp_code(cp_code_data: str) -> CPCode:
    if not isinstance(cp_code_data, str) or len(cp_code_data) not in (12, 16):
        raise ValueError("ID must be exactly 12 or 16 characters")

    if not cp_code_data.startswith("CP"):
        raise ValueError("ID must use prefix 'CP'")

    value = 0
    for char in cp_code_data[2:].upper():
        try:
            digit = ALPHABET.index(char)
        except ValueError:
            raise ValueError(f"invalid Base32 character: {char!r}") from None
        value = (value << 5) | digit

    checksum = value & 0xFF
    payload = value >> 8
    is_short = len(cp_code_data) == 12
    expected_checksum = zlib.crc32(payload.to_bytes(6 if is_short else 8, "big")) & 0xFF

    if checksum != expected_checksum:
        raise ValueError("invalid checksum")

    if is_short:
        epoch_id = (payload >> 34) & 0xFF
        ts_val = (payload >> 10) & ((1 << 24) - 1)
        region_id = ??
        node_id = 0
    else:
        epoch_id = (payload >> 54) & 0xFF
        ts_val = (payload >> 30) & ((1 << 24) - 1)
        region_id = ??
        node_id = payload & ((1 << 20) - 1)

    epoch = _get_epoch(epoch_id)
    timestamp = epoch.start + ts_val * epoch.resolution
    return CPCode(epoch_id, timestamp, region_id, node_id)


def main() -> None:
    prev_data = None
    for _ in range(4):
        cp_code = generate_cp_code(node_id=0)
        cp_code_data = encode_cp_code(cp_code)
        print(cp_code_data)
        assert parse_cp_code(cp_code_data) == cp_code

        if prev_data is not None:
            assert cp_code_data > prev_data
        prev_data = cp_code_data

if __name__ == "__main__":
    main()
