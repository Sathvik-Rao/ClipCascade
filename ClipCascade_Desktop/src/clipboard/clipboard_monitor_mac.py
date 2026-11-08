"""Poll and write NSPasteboard on AppKit's main thread only.

Clipboard conversion and network sends run on a worker so polling never blocks
AppKit. A generation token makes queued callbacks harmless after stop/restart.
"""
import logging
import queue
import threading

import pasteboard
from AppKit import NSPasteboard
from PyObjCTools import AppHelper
from utils.main_thread import on_main_thread

_session = None
_image_write_change_count = None
_pb_writer = None
_MAX_EMPTY_READS = 10


@on_main_thread
def write_to_pasteboard(data, pb_type):
    global _pb_writer, _image_write_change_count
    try:
        if _pb_writer is None:
            _pb_writer = pasteboard.Pasteboard()
        _pb_writer.set_contents(data, pb_type)
        if pb_type in (pasteboard.PNG, pasteboard.TIFF):
            # Bind echo suppression to our write, never to the next user image.
            _image_write_change_count = NSPasteboard.generalPasteboard().changeCount()
    except Exception:
        logging.exception("Failed to write to pasteboard")


def _deliver(session):
    while not session['stop'].is_set():
        try:
            kind, payload = session['queue'].get(timeout=0.3)
        except queue.Empty:
            continue
        if session['stop'].is_set():
            break
        try:
            session['callback'](kind, payload)
        except Exception:
            logging.exception("Error processing clipboard update")


def _poll(session):
    global _image_write_change_count
    if _session is not session or session['stop'].is_set():
        return
    try:
        # Create and retain every native pasteboard object on the main thread.
        if session['reader'] is None:
            session['reader'] = pasteboard.Pasteboard()
            session['board'] = NSPasteboard.generalPasteboard()
            session['change_count'] = session['board'].changeCount()
            return
        change_count = session['board'].changeCount()
        if change_count == session['change_count']:
            return
        if _image_write_change_count is not None:
            own_image = change_count == _image_write_change_count
            _image_write_change_count = None
            if own_image:
                session['change_count'] = change_count
                logging.info("macOS clipboard: suppressed received-image write (change %s)", change_count)
                return

        # Use one change counter for the entire clipboard. Per-format diff
        # cursors can get out of step when the clipboard changes during a read,
        # causing a file's text representation to be sent on a later poll.
        event = None
        pb = session['reader']
        for kind in session['kinds']:
            value = pb.get_file_urls() if kind == 'files' else pb.get_contents(
                type={'text': pasteboard.String, 'png': pasteboard.PNG, 'tiff': pasteboard.TIFF}[kind],
            )
            if value:
                event = ('image' if kind in ('png', 'tiff') else kind, value)
                break

        # Discard a mixed snapshot and retry the latest version next poll.
        if session['board'].changeCount() != change_count:
            return
        if event is None:
            # Browsers can announce a change before their image data is ready.
            # Retry the same version, but bound retries for unsupported content.
            attempts = session.get('empty_reads', 0) + 1 if session.get('empty_change') == change_count else 1
            session['empty_change'], session['empty_reads'] = change_count, attempts
            if attempts < _MAX_EMPTY_READS:
                if attempts == 1:
                    logging.info("macOS clipboard: no readable supported data yet; retrying change %s", change_count)
                return
            logging.info("macOS clipboard: no readable supported data after %s polls (change %s)", attempts, change_count)
        session['change_count'] = change_count
        if event:
            if event[0] == 'image':
                logging.info("macOS clipboard: queued image (%s bytes, change %s)", len(event[1]), change_count)
            # Only the latest clipboard matters if conversion falls behind.
            try:
                session['queue'].get_nowait()
            except queue.Empty:
                pass
            session['queue'].put_nowait(event)
    except Exception:
        logging.exception("Error polling pasteboard")
    finally:
        if _session is session and not session['stop'].is_set():
            AppHelper.callLater(0.3, _poll, session)


@on_main_thread
def on_update(callback, enable_image_monitoring=False, enable_file_monitoring=False):
    global _session
    if _session is not None:
        _session['callback'] = callback
        return
    kinds = (['files'] if enable_file_monitoring else []) + ['text']
    if enable_image_monitoring:
        kinds += ['png', 'tiff']
    session = dict(callback=callback, kinds=kinds, reader=None, board=None, change_count=None,
                   queue=queue.Queue(maxsize=1), stop=threading.Event())
    _session = session
    worker = threading.Thread(target=_deliver, args=(session,), daemon=True)
    session['worker'] = worker
    worker.start()
    _poll(session)


@on_main_thread
def stop():
    global _session, _image_write_change_count, _pb_writer
    if _session is not None:
        _session['stop'].set()
        # Release native references on the main thread too; never join a worker
        # from AppKit (it may be finishing a clipboard/network callback).
        _session['reader'] = None
        _session['board'] = None
        _session = None
    _image_write_change_count = None
    _pb_writer = None


def wait():
    session = _session
    if session is not None and threading.current_thread() is not threading.main_thread():
        session['worker'].join()
