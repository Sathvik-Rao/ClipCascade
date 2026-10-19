"""macOS layout adjustments for the pinned pystray backend."""

from pystray import Icon

from utils.main_thread import on_main_thread


class MacOSTrayIcon(Icon):
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
