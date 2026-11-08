"""Prepare clipboard snapshots without blocking the platform monitor."""
import logging
import threading


class ClipboardSuperseded(Exception):
    """The clipboard snapshot is no longer current."""


class ClipboardUpdateWorker:
    """One active snapshot and one replaceable pending snapshot per session."""

    def __init__(self, prepare, deliver):
        self._prepare = prepare
        self._deliver = deliver
        self._condition = threading.Condition()
        self._pending = None
        self._generation = 0
        self._stopped = False
        self._thread = threading.Thread(
            target=self._run, name="ClipboardPreparation", daemon=True
        )
        self._thread.start()

    def submit(self, kind, content):
        with self._condition:
            if self._stopped:
                return
            self._generation += 1
            self._pending = (self._generation, kind, content)
            self._condition.notify()

    def stop(self):
        # Never join here: a worker may be waiting for platform/UI dispatch.
        with self._condition:
            self._stopped = True
            self._generation += 1
            self._pending = None
            self._condition.notify()

    def invalidate(self):
        with self._condition:
            self._generation += 1
            self._pending = None

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._stopped or self._pending is not None)
                if self._stopped:
                    return
                generation, kind, content = self._pending
                self._pending = None

            def is_current(generation=generation):
                with self._condition:
                    return not self._stopped and generation == self._generation

            def deliver(payload, payload_type, content_size_bytes=None):
                if is_current():
                    self._deliver(payload, payload_type, is_current, content_size_bytes)

            def check_current():
                if not is_current():
                    raise ClipboardSuperseded()

            deliver.check_current = check_current

            try:
                self._prepare(deliver, content, kind)
            except ClipboardSuperseded:
                pass
            except Exception:
                logging.exception("Error preparing clipboard update")
            finally:
                # Do not retain the previous snapshot while waiting for another.
                content = None
