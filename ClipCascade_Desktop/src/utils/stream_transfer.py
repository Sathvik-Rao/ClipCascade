"""Byte-safe chunked transfer with hard size caps before assembly."""

from __future__ import annotations

import uuid
from typing import Iterator


def fragment_bytes(data: bytes, fragment_size: int) -> list[bytes]:
    if fragment_size < 1:
        raise ValueError("fragment_size must be >= 1")
    return [data[i : i + fragment_size] for i in range(0, len(data), fragment_size)]


def fragment_utf8_string(s: str, fragment_size: int) -> list[str]:
    """
    Split a UTF-8 string on byte boundaries without corrupting multi-byte sequences.
    """
    raw = s.encode("utf-8")
    chunks: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        end = min(i + fragment_size, n)
        # If we land mid multi-byte sequence, back up to a lead byte boundary.
        if end < n:
            while end > i and (raw[end] & 0xC0) == 0x80:
                end -= 1
            if end == i:
                # Pathological: single codepoint larger than fragment_size.
                end = min(i + fragment_size, n)
        chunks.append(raw[i:end].decode("utf-8"))
        i = end
    return chunks if chunks else [""]


class StreamAssembler:
    """Assembles ordered stream chunks with a hard total-size cap."""

    def __init__(self, stream_id: str, total_size: int, max_size: int):
        if total_size < 0:
            raise ValueError("total_size must be >= 0")
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        if total_size > max_size:
            raise ValueError(
                f"Stream total_size {total_size} exceeds max_size {max_size}"
            )
        self.stream_id = stream_id
        self.total_size = total_size
        self.max_size = max_size
        self._parts: dict[int, bytes] = {}
        self._received = 0
        self.complete = False

    def add_chunk(self, offset: int, chunk: bytes) -> bool:
        """
        Add a chunk at the given byte offset.
        Returns True when the full stream is assembled.
        """
        if self.complete:
            return True
        if offset < 0 or not isinstance(chunk, (bytes, bytearray)):
            raise ValueError("Invalid chunk")
        end = offset + len(chunk)
        if end > self.total_size:
            raise ValueError("Chunk exceeds declared total_size")
        if self._received - len(self._parts.get(offset, b"")) + len(chunk) > self.max_size:
            raise ValueError("Stream exceeds max_size")
        prev = self._parts.get(offset)
        if prev is not None:
            self._received -= len(prev)
        self._parts[offset] = bytes(chunk)
        self._received += len(chunk)
        if self._received == self.total_size and self._is_contiguous():
            self.complete = True
            return True
        return False

    def _is_contiguous(self) -> bool:
        if not self._parts:
            return self.total_size == 0
        cursor = 0
        for offset in sorted(self._parts):
            if offset != cursor:
                return False
            cursor = offset + len(self._parts[offset])
        return cursor == self.total_size

    def assemble(self) -> bytes:
        if not self.complete and self.total_size > 0:
            raise ValueError("Stream incomplete")
        return b"".join(self._parts[o] for o in sorted(self._parts))

    def assemble_text(self) -> str:
        return self.assemble().decode("utf-8")


def make_stream_id() -> str:
    return str(uuid.uuid4())


def iter_stream_chunks(
    payload: str, fragment_size: int, max_size: int
) -> Iterator[tuple[dict, str]]:
    """
    Yield (metadata, fragment) pairs for a string payload under a hard max_size.
    """
    raw = payload.encode("utf-8")
    total = len(raw)
    if total > max_size:
        raise ValueError(f"Payload {total} bytes exceeds max_size {max_size}")
    stream_id = make_stream_id()
    chunks = fragment_utf8_string(payload, fragment_size)
    total_fragments = len(chunks)
    for index, chunk in enumerate(chunks):
        meta = {
            "id": stream_id,
            "stream": True,
            "isFragmented": total_fragments > 1,
            "index": index,
            "totalFragments": total_fragments,
            "combinedRawPayloadSizeInBytes": total,
            "offset": sum(len(c.encode("utf-8")) for c in chunks[:index]),
            "chunkBytes": len(chunk.encode("utf-8")),
        }
        yield meta, chunk
