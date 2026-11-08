"""Flow control for the legacy P2P wire format."""
import asyncio
import json
import logging
import time


class TransferSuperseded(Exception):
    pass


async def wait_for_capacity(channel, size, check_current, limit=1024 * 1024, timeout=30):
    """Bound queued bytes per peer and stop waiting on a stalled connection."""
    previous = channel.bufferedAmount
    last_progress = time.monotonic()
    while True:
        check_current()
        if channel.readyState != "open":
            raise ConnectionError("Data channel closed during transfer")
        buffered = channel.bufferedAmount
        if buffered + size <= limit:
            return
        if buffered < previous:
            last_progress = time.monotonic()
        if time.monotonic() - last_progress >= timeout:
            raise TimeoutError("Data channel stopped draining")
        previous = buffered
        await asyncio.sleep(0.02)


async def send_shared_fragments(fragments, recipients, metadata, payload_type,
                                check_current, on_progress=lambda *_: None, allow_peer=lambda _: True, encode=None):
    """Run one sender per peer; retain only fragments still needed by a peer."""
    total = len(fragments)
    positions = [0] * len(recipients)
    released = 0
    canceled = False

    def check():
        if canceled:
            raise TransferSuperseded()
        check_current()

    def release_consumed():
        nonlocal released
        oldest = min(positions, default=total)
        while released < oldest:
            fragments[released] = None
            released += 1
        on_progress(oldest, total)

    async def send_peer(peer, channel):
        nonlocal canceled
        def check_peer():
            check()
            if not allow_peer(channel):
                raise ConnectionError("Peer receive limit changed")
        try:
            for index in range(total):
                check()
                if not allow_peer(channel):
                    return False
                body = (encode(fragments[index], {**metadata, "index": index}) if encode else
                        json.dumps({"payload": fragments[index], "type": payload_type,
                                    "metadata": {**metadata, "index": index}}))
                await wait_for_capacity(channel, len(body) if isinstance(body, bytes) else len(body.encode("utf-8")), check_peer)
                check()
                if not allow_peer(channel):
                    return False
                channel.send(body)
                positions[peer] = index + 1
                release_consumed()
                await asyncio.sleep(0)
            return True
        except TransferSuperseded:
            canceled = True
            raise
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # A closed/stalled peer must not stop the other recipients.
            logging.warning("P2P %s %s: peer %s send failed at fragment %s/%s: %s",
                            payload_type, metadata.get("id"), peer, positions[peer], total, error)
            return False
        finally:
            positions[peer] = total
            release_consumed()

    tasks = [asyncio.create_task(send_peer(peer, channel))
             for peer, channel in enumerate(recipients)]
    try:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, TransferSuperseded):
                raise result
        return sum(result is True for result in results)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        fragments.clear()
