"""Poll and write NSPasteboard on AppKit's main thread only.

Clipboard conversion and network sends run on a worker so polling never blocks
AppKit. A generation token makes queued callbacks harmless after stop/restart.
"""
import logging
import queue
import threading

import pasteboard
from PyObjCTools import AppHelper
from utils.main_thread import on_main_thread

_session = None
_block_image_once = False
_pb_writer = None


@on_main_thread
def write_to_pasteboard(data, pb_type):
    global _pb_writer
    try:
        if _pb_writer is None:
            _pb_writer = pasteboard.Pasteboard()
        _pb_writer.set_contents(data, pb_type)
    except Exception:
        logging.exception("Failed to write to pasteboard")


@on_main_thread
def enable_block_image_once():
    global _block_image_once
    _block_image_once = True


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
    global _block_image_once
    if _session is not session or session['stop'].is_set():
        return
    try:
        # Create and retain every native pasteboard object on the main thread.
        if not session['boards']:
            session['boards'] = [(kind, pasteboard.Pasteboard()) for kind in session['kinds']]
        updates = {}
        for kind, pb in session['boards']:
            value = pb.get_file_urls(diff=True) if kind == 'files' else pb.get_contents(
                type={'text': pasteboard.String, 'png': pasteboard.PNG, 'tiff': pasteboard.TIFF}[kind],
                diff=True,
            )
            if value:
                updates[kind] = value
        if not session['first']:
            event = None
            if 'files' in updates:
                event = ('files', updates['files'])
            elif 'text' in updates:
                event = ('text', updates['text'])
            elif 'png' in updates or 'tiff' in updates:
                if _block_image_once:
                    _block_image_once = False
                else:
                    event = ('image', updates.get('png', updates.get('tiff')))
            if event:
                # Only the latest clipboard matters if conversion falls behind.
                try:
                    session['queue'].get_nowait()
                except queue.Empty:
                    pass
                session['queue'].put_nowait(event)
        session['first'] = False
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
    session = dict(callback=callback, kinds=kinds, boards=[], first=True,
                   queue=queue.Queue(maxsize=1), stop=threading.Event())
    _session = session
    worker = threading.Thread(target=_deliver, args=(session,), daemon=True)
    session['worker'] = worker
    worker.start()
    _poll(session)


@on_main_thread
def stop():
    global _session, _block_image_once, _pb_writer
    if _session is not None:
        _session['stop'].set()
        # Release native references on the main thread too; never join a worker
        # from AppKit (it may be finishing a clipboard/network callback).
        _session['boards'].clear()
        _session = None
    _block_image_once = False
    _pb_writer = None


def wait():
    session = _session
    if session is not None and threading.current_thread() is not threading.main_thread():
        session['worker'].join()
