"""macOS event handling and layout for the pinned pystray backend."""

import logging
import signal

import objc
from AppKit import NSWorkspace, NSWorkspaceWillPowerOffNotification
from Foundation import NSAppleEventManager, NSObject
from PyObjCTools import AppHelper, MachSignals
from pystray import Icon

from utils.main_thread import on_main_thread


class QuitEventHandler(NSObject):
    @objc.signature(b"v@:@@")
    def handleQuitEvent_withReplyEvent_(self, event, reply):
        self.callback("quit Apple event")

    @objc.signature(b"v@:@")
    def workspaceWillPowerOff_(self, notification):
        self.callback("workspace logout/shutdown notification")


class MacOSTrayIcon(Icon):
    @on_main_thread
    def _update_menu(self):
        # Replacing the status item's NSMenu leaves an already open popup
        # showing the old objects. Keep its menu and update those objects.
        callbacks = []
        updated_menu = self._create_menu(self.menu, callbacks)
        if getattr(self, '_menu_handle', None) and updated_menu:
            native_menu, previous_callbacks = self._menu_handle
            self._sync_menu(native_menu, updated_menu)
            previous_callbacks[:] = callbacks
        else:
            self._status_item.setMenu_(updated_menu)
            self._menu_handle = (updated_menu, callbacks) if updated_menu else None

    @classmethod
    def _sync_menu(cls, native_menu, updated_menu):
        # Reuse matching rows so ordinary stats updates preserve the hovered
        # row and any open submenu. Add/remove rows when actions change.
        for position in range(updated_menu.numberOfItems()):
            updated = updated_menu.itemAtIndex_(position)
            if position >= native_menu.numberOfItems():
                native_menu.addItem_(updated.copy())
                continue
            current = native_menu.itemAtIndex_(position)
            if current.title() != updated.title():
                # Align existing actions before updating their properties. A
                # file-to-text refresh must remove Download File, not relabel
                # its attributed row and remove the original Stop sync row.
                matching_position = next((
                    index for index in range(position + 1, native_menu.numberOfItems())
                    if native_menu.itemAtIndex_(index).title() == updated.title()
                ), None)
                if matching_position is not None:
                    for _ in range(matching_position - position):
                        native_menu.removeItemAtIndex_(position)
                    current = native_menu.itemAtIndex_(position)
                elif any(
                    updated_menu.itemAtIndex_(index).title() == current.title()
                    for index in range(position + 1, updated_menu.numberOfItems())
                ):
                    native_menu.insertItem_atIndex_(updated.copy(), position)
                    continue
            if (current.isSeparatorItem() != updated.isSeparatorItem()
                    or bool(current.submenu()) != bool(updated.submenu())):
                native_menu.removeItemAtIndex_(position)
                native_menu.insertItem_atIndex_(updated.copy(), position)
                continue
            if current.isSeparatorItem():
                continue
            current.setTitle_(updated.title())
            current.setAttributedTitle_(updated.attributedTitle())
            current.setEnabled_(updated.isEnabled())
            current.setState_(updated.state())
            current.setTag_(updated.tag())
            if current.submenu():
                cls._sync_menu(current.submenu(), updated.submenu())
        while native_menu.numberOfItems() > updated_menu.numberOfItems():
            native_menu.removeItemAtIndex_(native_menu.numberOfItems() - 1)

    def run_with_shutdown(self, on_quit):
        # Tk installs a quit Apple-event handler that queues work in Tcl.
        # With AppKit driving the loop, handle that event directly instead.
        manager = NSAppleEventManager.sharedAppleEventManager()
        event_class = int.from_bytes(b"aevt", "big")  # kCoreEventClass
        event_id = int.from_bytes(b"quit", "big")  # kAEQuitApplication
        handler = QuitEventHandler.alloc().init()

        @on_main_thread
        def request_shutdown(source):
            logging.info("macOS received %s", source)
            on_quit()

        handler.callback = request_shutdown
        workspace = NSWorkspace.sharedWorkspace()
        notifications = workspace.notificationCenter()
        active = True
        previous_sigint = MachSignals.getsignal(signal.SIGINT)

        def handle_sigint(signum):
            request_shutdown("SIGINT (Ctrl+C)")

        def install_handler():
            if active:
                manager.setEventHandler_andSelector_forEventClass_andEventID_(
                    handler, b"handleQuitEvent:withReplyEvent:", event_class, event_id
                )
                # pystray installs its SIGINT handler just before entering the
                # loop. It calls Tk's terminate(), queuing an unserviced Tcl
                # event. MachSignals wakes AppKit and starts cleanup directly.
                MachSignals.signal(signal.SIGINT, handle_sigint)

        # NSApplication installs its own handlers during launch. Register after
        # the native loop starts so launch cannot replace our cleanup handler.
        # Also observe the workspace's logout/shutdown signal directly: it must
        # not depend on Tk processing its queued quit event or on mouse input.
        notifications.addObserver_selector_name_object_(
            handler, b"workspaceWillPowerOff:", NSWorkspaceWillPowerOffNotification, workspace
        )
        AppHelper.callAfter(install_handler)
        try:
            self.run()
        finally:
            active = False
            # The backend skips restoring SIGINT when its handler was replaced;
            # restore the mapping from before run() ourselves in that case.
            if MachSignals.getsignal(signal.SIGINT) is handle_sigint:
                MachSignals.signal(signal.SIGINT, previous_sigint)
            notifications.removeObserver_(handler)
            manager.removeEventHandlerForEventClass_andEventID_(event_class, event_id)

    @on_main_thread
    def _show(self):
        # pystray's default setup calls this from a worker thread.
        super()._show()

    @on_main_thread
    def _update_icon(self):
        super()._update_icon()

    def _assert_image(self):
        super()._assert_image()
        # pystray 0.19.5 leaves NSImage's point size implicit and uses a
        # variable-width status item. Use a square slot matching the image
        # so the artwork stays centered without extra horizontal padding.
        thickness = self._status_bar.thickness()
        self._icon_image.setSize_((thickness, thickness))
        self._status_item.setLength_(thickness)
