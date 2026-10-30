"""Live menu updates for the pinned pystray Windows backend."""

import ctypes
from ctypes import wintypes

from pystray import Icon, Menu
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


def _shape(menu):
    return tuple(
        "separator" if entry is Menu.SEPARATOR else
        _shape(entry.submenu) if entry.submenu else "item"
        for entry in menu
    )


class WindowsTrayIcon(Icon):
    _REFRESH_MENU = win32.WM_USER + 20

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._menu_handle = None
        self._menu_shape = None
        self._message_handlers[self._REFRESH_MENU] = self._refresh_menu

    def _update_menu(self):
        # TrackPopupMenuEx runs a nested message loop. Posting to the icon's
        # window also services updates while that popup is tracking the mouse.
        if self._hwnd:
            win32.PostMessage(self._hwnd, self._REFRESH_MENU, 0, 0)

    def _refresh_menu(self, wparam, lparam):
        if not self._running:
            return
        menu = self.menu
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

    def _sync_menu(self, hmenu, menu, callbacks, insert):
        for position, entry in enumerate(menu):
            callbacks.append(self._handler(entry))
            command_id = len(callbacks)
            if entry is Menu.SEPARATOR:
                info = win32.MENUITEMINFO(
                    cbSize=ctypes.sizeof(win32.MENUITEMINFO),
                    fMask=win32.MIIM_FTYPE, fType=win32.MFT_SEPARATOR,
                )
            else:
                submenu = None
                if entry.submenu:
                    submenu = win32.CreatePopupMenu() if insert else _get_submenu(hmenu, position)
                    self._sync_menu(submenu, entry.submenu, callbacks, insert)
                info = win32.MENUITEMINFO(
                    cbSize=ctypes.sizeof(win32.MENUITEMINFO),
                    fMask=win32.MIIM_ID | win32.MIIM_STRING | win32.MIIM_STATE
                    | win32.MIIM_FTYPE | win32.MIIM_SUBMENU,
                    wID=command_id, dwTypeData=entry.text, hSubMenu=submenu,
                    fState=(win32.MFS_DEFAULT if entry.default else 0)
                    | (win32.MFS_CHECKED if entry.checked else 0)
                    | (win32.MFS_DISABLED if not entry.enabled else 0),
                    fType=win32.MFT_RADIOCHECK if entry.radio else 0,
                )
            if insert:
                win32.InsertMenuItem(hmenu, position, True, ctypes.byref(info))
            else:
                if not _set_menu_item(hmenu, position, True, ctypes.byref(info)):
                    raise ctypes.WinError()
