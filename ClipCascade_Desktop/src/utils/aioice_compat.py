"""Compatibility fixes for the aioice versions used by desktop clients."""

from functools import wraps

import aioice
from aioice import stun


def install_stun_retry_guard() -> None:
    """Stop late retry callbacks from sending or completing a finished transaction.

    aioice 0.9/0.10 checks Future.done() when receiving a response, but not
    when its retry timer fires. A ready timer can run before cancellation
    cleanup gets a turn on the event loop. Guard the callback itself, while
    leaving active transactions and their errors to aioice.
    """
    if not aioice.__version__.startswith(("0.9.", "0.10.")):
        return
    retry = getattr(stun.Transaction, "_Transaction__retry", None)
    if retry is None or getattr(retry, "_clipcascade_guard", False):
        return

    @wraps(retry)
    def guarded_retry(transaction):
        future = getattr(transaction, "_Transaction__future", None)
        if future is not None and future.done():
            return
        return retry(transaction)

    guarded_retry._clipcascade_guard = True
    stun.Transaction._Transaction__retry = guarded_retry
