import tkinter as tk
import webbrowser
import threading
from pystray import Icon, MenuItem as item, Menu
from PIL import Image, ImageDraw

from gui.info import CustomDialog


class TaskbarPanel:
    def __init__(
        self,
        on_connect_callback=None,
        on_disconnect_callback=None,
        on_logoff_callback=None,
        new_version_available=None,
    ):
        self.on_connect_callback = on_connect_callback
        self.on_disconnect_callback = on_disconnect_callback
        self.on_logoff_callback = on_logoff_callback
        self.new_version_available = new_version_available

        self.root = tk.Tk()
        self.root.withdraw()  # Hide the root window

        # Initial state: Connected
        self.is_connected = True

        # Create the tray icon
        self.icon = Icon(
            "ClipCascade", self.create_clipboard_icon(), menu=self.create_menu()
        )

        self.icon.title = "ClipCascade"

    def run(self):
        self.icon.run()

    def create_clipboard_icon(self):
        # Create a new image with a white background
        width, height = 64, 64  # Icon dimensions
        image = Image.new("RGBA", (width, height), (255, 255, 255, 0))

        draw = ImageDraw.Draw(image)

        # Draw a clipboard shape
        clipboard_rect = [15, 10, 49, 50]
        draw.rectangle(clipboard_rect, fill=(200, 200, 200), outline=(0, 0, 0))

        # Draw the clipboard clip
        clip_rect = [25, 5, 35, 10]
        draw.rectangle(clip_rect, fill=(150, 150, 150), outline=(0, 0, 0))

        return image

    def create_menu(self):
        # Menu items
        menu_items = [
            item("GitHub", self._open_github),
            item("Logoff and Quit", self._on_logoff),
            item("Quit", self._on_quit),
        ]

        if not self.is_connected:
            menu_items.insert(0, item("Connect", self._on_connect, default=True))
        else:
            menu_items.insert(0, item("Disconnect", self._on_disconnect))

        if self.new_version_available is not None and self.new_version_available[0]:
            menu_items.insert(
                0,
                item(
                    f"Update ({self.new_version_available[2]} ➞ {self.new_version_available[1]})",
                    self._on_update,
                ),
            )

        return Menu(*menu_items)

    def open_webbrowser(self, url):
        try:
            webbrowser.open(url)
        except Exception as e:
            threading.Thread(
                target=lambda: CustomDialog(
                    f"Failed to open the browser. Here is the URL: {url}\nError: {e}",
                    msg_type="error",
                ).mainloop()
            ).start()

    def _on_update(self, icon, item):
        self.open_webbrowser(
            "https://github.com/Sathvik-Rao/ClipCascade/releases/latest"
        )

    def _on_connect(self, icon, item):
        if self.on_connect_callback:
            try:
                self.on_connect_callback()
            except Exception as e:
                pass
            self.is_connected = True
            icon.menu = self.create_menu()

    def _on_disconnect(self, icon, item):
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
            self.is_connected = False
            icon.menu = self.create_menu()

    def _open_github(self, icon, item):
        self.open_webbrowser("https://github.com/Sathvik-Rao/ClipCascade")

    def _on_logoff(self, icon, item):
        try:
            if self.on_logoff_callback:
                self.on_logoff_callback()
            self.icon.stop()
            self.root.quit()
        except Exception as e:
            threading.Thread(
                target=lambda: CustomDialog(
                    f"An error occurred while logging off: {e}", msg_type="error"
                ).mainloop()
            ).start()

    def _on_quit(self, icon, item):
        self.icon.stop()
        self.root.quit()
