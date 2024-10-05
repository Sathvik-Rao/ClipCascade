import tkinter as tk
import webbrowser
from tkinter import messagebox
from pystray import Icon, MenuItem as item, Menu
from PIL import Image, ImageDraw

from gui.info import CustomDialog


class TaskbarPanel:
    def __init__(
        self,
        on_connect_callback=None,
        on_disconnect_callback=None,
        on_logoff_callback=None,
    ):
        self.on_connect_callback = on_connect_callback
        self.on_disconnect_callback = on_disconnect_callback
        self.on_logoff_callback = on_logoff_callback

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
        if not self.is_connected:
            return Menu(
                item("Connect", self._on_connect, default=True),
                item("GitHub", self._open_github),
                item("Logoff and Quit", self._on_logoff),
                item("Quit", self._on_quit),
            )
        else:
            return Menu(
                item("Disconnect", self._on_disconnect),
                item("GitHub", self._open_github),
                item("Logoff and Quit", self._on_logoff),
                item("Quit", self._on_quit),
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
        webbrowser.open("https://github.com/Sathvik-Rao/ClipCascade")

    def _on_logoff(self, icon, item):
        response = messagebox.askquestion("Logoff", "Are you sure you want to log off?")
        if response == "yes":
            try:
                if self.on_logoff_callback:
                    self.on_logoff_callback()
                self.icon.stop()
                self.root.quit()
            except Exception as e:
                CustomDialog(
                    f"An error occurred while logging off: {e}", msg_type="error"
                ).mainloop()

    def _on_quit(self, icon, item):
        self.icon.stop()
        self.root.quit()
