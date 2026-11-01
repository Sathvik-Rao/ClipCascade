"""Live menu updates for the pinned pystray Windows backend."""

import ctypes
import signal
from ctypes import wintypes

from pystray import Icon, Menu, MenuItem
from pystray._util import win32


_set_menu_item = ctypes.windll.user32.SetMenuItemInfoW
_set_menu_item.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.BOOL,
                          ctypes.POINTER(win32.MENUITEMINFO)]
_set_menu_item.restype = wintypes.BOOL
_get_submenu = ctypes.windll.user32.GetSubMenu
_get_submenu.argtypes = [wintypes.HMENU, ctypes.c_int]
_get_submenu.restype = wintypes.HMENU
_delete_menu = ctypes.windll.user32.DeleteMenu
_delete_menu.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
_delete_menu.restype = wintypes.BOOL
_get_menu_count = ctypes.windll.user32.GetMenuItemCount
_get_menu_count.argtypes = [wintypes.HMENU]
_get_menu_count.restype = ctypes.c_int
_set_menu_default = ctypes.windll.user32.SetMenuDefaultItem
_set_menu_default.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
_set_menu_default.restype = wintypes.BOOL
_set_timer = ctypes.windll.user32.SetTimer
_set_timer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, wintypes.LPVOID]
_set_timer.restype = ctypes.c_size_t
_kill_timer = ctypes.windll.user32.KillTimer
_kill_timer.argtypes = [wintypes.HWND, ctypes.c_size_t]
_kill_timer.restype = wintypes.BOOL


def _key(entry):
    return getattr(entry, '_clipcascade_key', entry.text)


def _shape(menu):
    return tuple(
        "separator" if entry is Menu.SEPARATOR else
        (_key(entry), _shape(entry.submenu) if entry.submenu else None)
        for entry in menu
    )


def _keep_layout(displayed, latest):
    """Refresh existing rows without moving or replacing any displayed action."""
    incoming = {_key(entry): entry for entry in latest if entry is not Menu.SEPARATOR}
    rows = []
    for old in displayed:
        if old is Menu.SEPARATOR:
            rows.append(old)
            continue
        current = incoming.get(_key(old))
        # A leaf/submenu conversion is structural too. Disable the old action
        # until the popup closes rather than retargeting a click mid-selection.
        if current is not None and bool(old.submenu) != bool(current.submenu):
            current = None
        if old.submenu:
            action = _keep_layout(old.submenu, current.submenu if current else ())
        else:
            action = current._action if current is not None else None
        row = MenuItem(
            current.text if current is not None else old.text, action,
            enabled=current.enabled if current is not None else False,
            checked=current.checked if current is not None else old.checked,
            radio=current.radio if current is not None else old.radio,
            default=current.default if current is not None else old.default,
        )
        row._clipcascade_key = _key(old)
        rows.append(row)
    return Menu(*rows)


class WindowsTrayIcon(Icon):
    _REFRESH_MENU = win32.WM_USER + 20
    _SIGNAL_TIMER = 0x4343
    _WM_TIMER = 0x0113

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._menu_handle = None
        self._menu_shape = None
        self._displayed_menu = Menu()
        self._menu_open = False
        self._signal_quit_pending = False
        self._signal_quit_dispatched = False
        self._signal_quit_callback = None
        self._message_handlers[self._REFRESH_MENU] = self._refresh_menu
        self._message_handlers[self._WM_TIMER] = self._on_signal_timer

    def run_with_shutdown(self, on_quit):
        previous_handlers = {}
        self._signal_quit_callback = on_quit
        self._signal_quit_pending = False
        self._signal_quit_dispatched = False

        def request_quit(signum, frame):
            # Signals can arrive inside a ctypes callback or while a lock is
            # held. Only set a flag here; the UI timer starts cleanup safely.
            self._signal_quit_pending = True

        try:
            for signum in (signal.SIGINT, signal.SIGBREAK):
                previous_handlers[signum] = signal.signal(signum, request_quit)
            self.run()
        finally:
            for signum, previous in previous_handlers.items():
                signal.signal(signum, previous)
            self._signal_quit_callback = None

    def _on_signal_timer(self, wparam, lparam):
        if (wparam == self._SIGNAL_TIMER and self._signal_quit_pending
                and not self._signal_quit_dispatched):
            self._signal_quit_dispatched = True
            self._signal_quit_callback()

    def _mainloop(self):
        if self._signal_quit_callback is None:
            return super()._mainloop()
        # GetMessage can otherwise leave Python signals pending until another
        # window message arrives. WM_TIMER also works in popup menu loops.
        timer = _set_timer(self._hwnd, self._SIGNAL_TIMER, 250, None)
        if not timer:
            raise ctypes.WinError()
        try:
            return super()._mainloop()
        finally:
            _kill_timer(self._hwnd, self._SIGNAL_TIMER)

    def _on_notify(self, wparam, lparam):
        if lparam != win32.WM_RBUTTONUP:
            return super()._on_notify(wparam, lparam)
        if self._menu_open:
            return
        self._refresh_menu(0, 0)
        self._menu_open = True
        try:
            # The backend dispatches the selected command before returning.
            # Keep its IDs and callbacks stable until that dispatch is done.
            return super()._on_notify(wparam, lparam)
        finally:
            self._menu_open = False
            self._refresh_menu(0, 0)

    def _update_menu(self):
        # TrackPopupMenuEx runs a nested message loop. Posting to the icon's
        # window also services updates while that popup is tracking the mouse.
        if self._hwnd:
            win32.PostMessage(self._hwnd, self._REFRESH_MENU, 0, 0)

    def _refresh_menu(self, wparam, lparam):
        if not self._running:
            return
        menu = self.menu
        if self._menu_open:
            # New/removed actions wait until closing; stats and enabled states
            # still refresh in their existing positions. No submenu is deleted.
            menu = _keep_layout(self._displayed_menu, menu or ())
        shape = _shape(menu) if menu else ()
        if not self._menu_handle:
            callbacks = []
            self._menu_handle = (win32.CreatePopupMenu(), callbacks)
        hmenu, callbacks = self._menu_handle
        rebuild = shape != self._menu_shape
        if rebuild:
            # Keep the root HMENU that TrackPopupMenuEx is displaying alive.
            for position in reversed(range(_get_menu_count(hmenu))):
                _delete_menu(hmenu, position, 0x0400)  # MF_BYPOSITION
        updated_callbacks = []
        self._sync_menu(hmenu, menu or (), updated_callbacks, rebuild)
        # pystray holds this list across TrackPopupMenuEx; preserve its identity
        # so a click uses the callbacks corresponding to the displayed IDs.
        callbacks[:] = updated_callbacks
        self._menu_shape = shape
        self._displayed_menu = menu or Menu()

    def _sync_menu(self, hmenu, menu, callbacks, insert):
        default_position = 0xFFFFFFFF  # No default menu item.
        for position, entry in enumerate(menu):
            callbacks.append(self._handler(entry))
            command_id = len(callbacks)
            if entry is Menu.SEPARATOR:
                # The shape check guarantees this is already a separator.
                # Do not reset its type while Windows is tracking the menu.
                if not insert:
                    continue
                info = win32.MENUITEMINFO(
                    cbSize=ctypes.sizeof(win32.MENUITEMINFO),
                    fMask=win32.MIIM_FTYPE, fType=win32.MFT_SEPARATOR,
                )
            else:
                if entry.default:
                    default_position = position
                submenu = None
                if entry.submenu:
                    submenu = win32.CreatePopupMenu() if insert else _get_submenu(hmenu, position)
                    self._sync_menu(submenu, entry.submenu, callbacks, insert)
                info = win32.MENUITEMINFO(
                    cbSize=ctypes.sizeof(win32.MENUITEMINFO),
                    fMask=win32.MIIM_ID | win32.MIIM_STRING | win32.MIIM_STATE
                    | win32.MIIM_FTYPE | win32.MIIM_SUBMENU,
                    wID=command_id, dwTypeData=entry.text, hSubMenu=submenu,
                    fState=(win32.MFS_CHECKED if entry.checked else 0)
                    | (win32.MFS_DISABLED if not entry.enabled else 0),
                    fType=win32.MFT_RADIOCHECK if entry.radio else 0,
                )
                if not insert:
                    # Existing submenus are already attached. Only insertion
                    # changes ownership; a live refresh updates their contents.
                    info.fMask &= ~win32.MIIM_SUBMENU
            if insert:
                win32.InsertMenuItem(hmenu, position, True, ctypes.byref(info))
            else:
                if not _set_menu_item(hmenu, position, True, ctypes.byref(info)):
                    raise ctypes.WinError()
        # SetMenuItemInfo rejects MFS_DEFAULT when refreshing an existing
        # default item (WinError 87). Use the dedicated API after row updates.
        if not _set_menu_default(hmenu, default_position, True):
            raise ctypes.WinError()
