import re
import tkinter as tk
from tkinter import ttk, font
import gc
import time
import os

from utils.window_manager import center_window
from core.config import Config
from gui.info import CustomDialog
from core.constants import *


class HoverTooltip:
    """Simple hover tooltip for Tk widgets."""

    def __init__(self, widget, text, wraplength=520):
        self.widget = widget
        self.text = text
        self.wraplength = wraplength
        self.tooltip_window = None
        self.widget.bind("<Enter>", self._show, add="+")
        self.widget.bind("<Leave>", self._hide, add="+")
        self.widget.bind("<ButtonPress>", self._hide, add="+")

    def _show(self, _event=None):
        if self.tooltip_window or not self.text.strip():
            return

        # Position tooltip near the widget with an offset.
        x = self.widget.winfo_rootx() + 18
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 8

        self.tooltip_window = tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x}+{y}")

        label = tk.Label(
            tw,
            text=self.text,
            justify=tk.LEFT,
            relief=tk.SOLID,
            borderwidth=1,
            background="#ffffe0",
            foreground="#202020",
            font=("Helvetica", 10),
            wraplength=self.wraplength,
            padx=8,
            pady=6,
        )
        label.pack()

    def _hide(self, _event=None):
        if self.tooltip_window:
            self.tooltip_window.destroy()
            self.tooltip_window = None


class LoginForm(tk.Tk):
    def __init__(
        self,
        config: Config,
        on_login_callback=None,
        on_quit_callback=None,
    ):
        super().__init__()
        self.config = config
        self.on_login_callback = on_login_callback
        self.on_quit_callback = on_quit_callback

        if PLATFORM == MACOS or PLATFORM.startswith(LINUX):
            # Set an initial size to avoid 0 size issue
            # self.geometry("800x450")
            self.update_idletasks()

        self.withdraw()  # Hide the root window
        self.title("ClipCascade")
        self._tooltips = []

        # Make the window appear on top and grab focus
        self.attributes("-topmost", True)
        self.focus_force()

        # Configure styles
        style = ttk.Style(self)
        # Use default theme (may vary by OS); consider 'clam', 'alt', or 'default'
        style.configure("TLabel", font=("Helvetica", 13), padding=5)
        style.configure("TEntry", font=("Helvetica", 13), padding=5)
        style.configure("TButton", font=("Helvetica", 13), padding=5)
        style.configure("TCheckbutton", font=("Helvetica", 13), padding=5)

        # Main frame with padding
        main_frame = ttk.Frame(self, padding=20)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title Label
        title_label = ttk.Label(
            main_frame,
            text="Please Log In",
            font=("Helvetica", 16, "bold"),
            takefocus=False,
        )
        title_label.pack(pady=(0, 10))

        # Create a frame for the fields
        self.field_frame = ttk.Frame(main_frame)
        self.field_frame.pack(padx=10, pady=10, fill=tk.X)

        # Username
        user_label = ttk.Label(self.field_frame, text="Username:")
        user_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.username_entry = ttk.Entry(self.field_frame, width=50, font=("Helvetica", 13))
        self.username_entry.insert(0, self.config.data["username"])
        self.username_entry.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [user_label, self.username_entry],
            "Username used to log in to your ClipCascade account.\n\n"
            "Use the same account name on all devices that should share clipboard data.",
        )

        # Password
        pass_label = ttk.Label(self.field_frame, text="Password:")
        pass_label.grid(row=1, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.password_frame = ttk.Frame(self.field_frame)
        self.password_frame.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self.password_entry = ttk.Entry(
            self.password_frame, show="*", width=47, font=("Helvetica", 13)
        )
        self.password_entry.insert(0, self.config.data["password"])
        self.password_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)

        self.eye_icon = ttk.Label(
            self.password_frame, text="🙈", cursor="hand2", takefocus=False
        )
        self.eye_icon.pack(side=tk.RIGHT, padx=(5, 0))
        self.eye_icon.bind("<Button-1>", self._toggle_password)
        self._add_tooltip(
            [pass_label, self.password_entry, self.eye_icon],
            "Account password used for server authentication.\n\n"
            "If encryption is enabled, this password is also used to derive your encryption key.\n"
            "Use the same password on all devices for successful decrypt/sync.",
        )

        # Server URL
        server_label = ttk.Label(self.field_frame, text="Server URL:")
        server_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.server_url_entry = ttk.Entry(self.field_frame, width=50, font=("Helvetica", 13))
        self.server_url_entry.insert(0, self.config.data["server_url"])
        self.server_url_entry.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [server_label, self.server_url_entry],
            "Address of your ClipCascade server.\n\n"
            "Examples:\n"
            "- Local server: http://localhost:8080\n"
            "- LAN server: http://192.168.1.50:8080\n"
            "- Reverse proxy/domain: https://clipcascade.example.com\n\n"
            "Include protocol (http/https). Do not add /login or /clipsocket.",
        )

        # Configure grid weights to ensure entries expand
        self.field_frame.columnconfigure(1, weight=1)

        # Checkboxes frame
        checks_frame = ttk.Frame(main_frame)
        checks_frame.pack(pady=(5, 10), fill=tk.X)

        # Encryption Checkbox
        self.cipher_var = tk.BooleanVar(value=self.config.data["cipher_enabled"])
        self.cipher_checkbox = ttk.Checkbutton(
            checks_frame,
            text="Enable Encryption (recommended)",
            variable=self.cipher_var,
            takefocus=False,
        )
        self.cipher_checkbox.pack(pady=3, anchor=tk.W)
        self._add_tooltip(
            [self.cipher_checkbox],
            "Enables end-to-end encryption for clipboard content (recommended).\n\n"
            "When enabled, clipboard data is encrypted on-device before sending.\n"
            "All devices in the same account must use the same encryption settings "
            "(password, salt, and hash rounds) to decrypt data correctly.",
        )

        # Notification Checkbox
        self.notification_var = tk.BooleanVar(value=self.config.data["notification"])
        self.notification_checkbox = ttk.Checkbutton(
            checks_frame,
            text="Enable Notification",
            variable=self.notification_var,
            takefocus=False,
        )
        self.notification_checkbox.pack(pady=3, anchor=tk.W)
        self._add_tooltip(
            [self.notification_checkbox],
            "Shows local notifications for connection status events.\n\n"
            "Useful to know when WebSocket disconnects/reconnects happen.\n"
            "Turn this off if you prefer a quieter experience with fewer popups.",
        )

        # Button frame
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(pady=(10, 0))

        # Login Button
        self.login_button = ttk.Button(button_frame, text="Login", command=self.on_login)
        self.login_button.pack()

        # Extra Configurations Toggle Label
        # macOS: show advanced fields by default
        self.show_extra = PLATFORM == MACOS
        self.toggle_normal_color = "#007acc"  # neutral blue with strong contrast
        self.toggle_hover_color = "#005a9e"  # slightly darker for hover feedback
        self.toggle_label = tk.Label(
            main_frame,
            text="Hide Extra Config" if PLATFORM == MACOS else "Enable Extra Config",
            fg=self.toggle_normal_color,
            cursor="hand2",
            font=font.Font(family="Helvetica", size=13, underline=True),
            takefocus=False,
        )
        self.toggle_label.pack(pady=(5, 10))
        self.toggle_label.bind("<Button-1>", self._toggle_extra_config)
        self._add_tooltip(
            [self.toggle_label],
            "Shows advanced settings for encryption and clipboard behavior.\n\n"
            "Most users can keep defaults. Open this section only if you need custom tuning.",
        )

        # hover effects for the toggle label
        self.toggle_label.bind("<Enter>", self._on_hover)
        self.toggle_label.bind("<Leave>", self._on_leave)

        # Extra Configuration Frame with Scrollbar
        self.extra_frame_container = ttk.Frame(main_frame)
        if PLATFORM == MACOS:
            self.extra_frame_container.pack(fill=tk.BOTH, expand=True)
        else:
            self.extra_frame_container.pack_forget()

        # Create a canvas inside the extra_frame_container
        self.extra_canvas = tk.Canvas(
            self.extra_frame_container,
            borderwidth=0,
            background="#f0f0f0",
            takefocus=False,
        )
        self.extra_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Add a vertical scrollbar to the canvas
        self.scrollbar = ttk.Scrollbar(
            self.extra_frame_container,
            orient="vertical",
            command=self.extra_canvas.yview,
            takefocus=False,
        )
        self.scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Configure the canvas to use the scrollbar
        self.extra_canvas.configure(yscrollcommand=self.scrollbar.set)

        # Create a frame inside the canvas to hold the extra configuration widgets
        self.extra_frame = ttk.Frame(self.extra_canvas, padding=10)
        self.extra_frame_window = self.extra_canvas.create_window(
            (0, 0), window=self.extra_frame, anchor="nw"
        )

        # Bind the configure event to update the scrollregion
        self.extra_frame.bind(
            "<Configure>",
            lambda event: self.extra_canvas.configure(scrollregion=self.extra_canvas.bbox("all")),
        )

        # Bind a configure event to the container to adjust the width
        self.extra_frame_container.bind("<Configure>", self._on_extra_container_configure)

        # Hash Rounds
        hash_rounds_label = ttk.Label(self.extra_frame, text="Hash Rounds:")
        hash_rounds_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.hash_rounds_entry = ttk.Entry(self.extra_frame, width=50, font=("Helvetica", 13))
        self.hash_rounds_entry.insert(0, str(self.config.data["hash_rounds"]))
        self.hash_rounds_entry.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [hash_rounds_label, self.hash_rounds_entry],
            "Number of hash iterations used for encryption key derivation.\n\n"
            "Higher value = stronger brute-force resistance, but slower processing.\n"
            "Default is tuned for balance. Keep default unless you know why to change.\n"
            "Must be a positive integer and must match on every device.",
        )

        # Salt
        salt_label = ttk.Label(self.extra_frame, text="Salt:")
        salt_label.grid(row=1, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.salt_entry = ttk.Entry(self.extra_frame, width=50, font=("Helvetica", 13))
        self.salt_entry.insert(0, self.config.data["salt"])
        self.salt_entry.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [salt_label, self.salt_entry],
            "Optional extra text mixed into encryption key generation.\n\n"
            "It can be any combination of letters and numbers (you can also include symbols/spaces if desired).\n"
            "Use the same exact salt on all devices if encryption is enabled.\n"
            "If left blank, encryption still works using password + hash rounds.\n"
            "Changing salt later will prevent old devices from decrypting new clipboard data.",
        )

        # Save Password Locally Checkbox
        save_password_label = ttk.Label(
            self.extra_frame,
            text="Store Password Locally\n(not recommended; \nonly works if encryption is disabled):",
        )
        save_password_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.save_password_var = tk.BooleanVar(value=self.config.data["save_password"])
        self.save_password_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.save_password_var,
            takefocus=False,
        )
        self.save_password_checkbox.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [save_password_label, self.save_password_checkbox],
            "Stores your plain password locally for automatic login convenience.\n\n"
            "Security trade-off: avoid this on shared or untrusted machines.\n"
            "This only works when encryption is disabled.",
        )

        # Maximum Clipboard Size - Local Limit
        local_clipboard_size_label = ttk.Label(
            self.extra_frame, text="Maximum Clipboard Size\nLocal Limit (in bytes):"
        )
        local_clipboard_size_label.grid(row=3, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.local_clipboard_size_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.local_clipboard_size_entry.insert(
            0, str(self.config.data["max_clipboard_size_local_limit_bytes"] or "")
        )
        self.local_clipboard_size_entry.grid(row=3, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [local_clipboard_size_label, self.local_clipboard_size_entry],
            "Optional local safety limit for clipboard payload size (incoming and outgoing) in bytes.\n\n"
            "Example: 1 MiB = 1048576 bytes.\n"
            "Leave empty for no local limit.\n"
            "Use a lower value if your device struggles with very large clipboard data "
            "(large text/images/files). Must be a positive integer.",
        )

        # Enable Image Sharing Checkbox
        enable_image_sharing_label = ttk.Label(self.extra_frame, text="Enable Image Sharing:")
        enable_image_sharing_label.grid(row=4, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.enable_image_sharing_var = tk.BooleanVar(
            value=self.config.data["enable_image_sharing"]
        )
        self.enable_image_sharing_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.enable_image_sharing_var,
            takefocus=False,
        )
        self.enable_image_sharing_checkbox.grid(row=4, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [enable_image_sharing_label, self.enable_image_sharing_checkbox],
            "Controls whether this device sends copied images to other devices.\n\n"
            "If disabled, this device can still receive images sent from other devices.",
        )

        # Enable File Sharing Checkbox
        enable_file_sharing_label = ttk.Label(self.extra_frame, text="Enable File Sharing:")
        enable_file_sharing_label.grid(row=5, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.enable_file_sharing_var = tk.BooleanVar(value=self.config.data["enable_file_sharing"])
        self.enable_file_sharing_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.enable_file_sharing_var,
            takefocus=False,
        )
        self.enable_file_sharing_checkbox.grid(row=5, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [enable_file_sharing_label, self.enable_file_sharing_checkbox],
            "Controls whether this device sends copied/shared files to other devices.\n\n"
            "If disabled, this device can still receive files sent from other devices.",
        )

        # Default File Download Location
        default_file_download_location_label = ttk.Label(
            self.extra_frame, text="Default File Download Location:"
        )
        default_file_download_location_label.grid(
            row=6, column=0, padx=(0, 10), pady=5, sticky=tk.W
        )
        self.default_file_download_location_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.default_file_download_location_entry.insert(
            0, self.config.data["default_file_download_location"]
        )
        self.default_file_download_location_entry.grid(
            row=6, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )
        self._add_tooltip(
            [default_file_download_location_label, self.default_file_download_location_entry],
            "Optional default folder to save incoming files automatically.\n\n"
            "Examples:\n"
            "- Windows: C:\\Users\\YourName\\Downloads\n"
            "- macOS/Linux: /Users/yourname/Downloads\n\n"
            "Leave blank to choose a location manually when downloading files.\n"
            "Path must already exist on this device.",
        )

        # SSL CA bundle (private / corporate PKI)
        ssl_ca_label = ttk.Label(self.extra_frame, text="SSL CA bundle (optional):")
        ssl_ca_label.grid(row=7, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.ssl_ca_bundle_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.ssl_ca_bundle_entry.insert(
            0, self.config.data.get("ssl_ca_bundle") or ""
        )
        self.ssl_ca_bundle_entry.grid(row=7, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [ssl_ca_label, self.ssl_ca_bundle_entry],
            "Path to a PEM file that contains your root CA (or full chain) for HTTPS/WSS.\n\n"
            "Leave empty for default verification (public CAs / OS defaults).\n"
            "Use this when your server uses a certificate from a private or internal CA.\n\n"
            "Example: /etc/ssl/corp-root.pem or C:\\\\certs\\\\corp-root.pem",
        )

        # Configure grid weights for extra_frame
        self.extra_frame.columnconfigure(1, weight=1)

        # Bind mouse wheel events for scrolling
        self._bind_mousewheel()

        # Handle window close
        self.protocol("WM_DELETE_WINDOW", self.on_quit)

        # Update idle tasks to calculate widget sizes
        self.update_idletasks()

        # Set a maximum height for the window
        self.max_window_height = 600

        # on press enter key
        self.bind("<Return>", lambda event: self.on_login())

        self._sync_login_tab_order()

        self.deiconify()  # Show window
        self.update_idletasks()
        center_window(self, self.max_window_height)

        # Drop always-on-top after showing
        self.after(300, lambda: self.attributes("-topmost", False))

        if PLATFORM == MACOS:
            self.after(400, self._macos_restore_focus)

    def _sync_login_tab_order(self):
        """Tab cycles username → password → server → Login → [extra entries if shown] → repeat.
        Checkboxes and chrome are excluded from keyboard focus."""
        extra_entries = (
            self.hash_rounds_entry,
            self.salt_entry,
            self.local_clipboard_size_entry,
            self.default_file_download_location_entry,
            self.ssl_ca_bundle_entry,
        )
        for w in extra_entries:
            w.configure(takefocus=bool(self.show_extra))

    def _add_tooltip(self, widgets, text):
        for widget in widgets:
            self._tooltips.append(HoverTooltip(widget, text))

    def _macos_restore_focus(self):
        """Force macOS to properly activate and focus the window.
        Needed after sequential tk.Tk() creation/destruction cycles."""
        try:
            from AppKit import NSApplication
            app = NSApplication.sharedApplication()
            app.activateIgnoringOtherApps_(True)
        except ImportError:
            pass
        self.lift()
        self.focus_force()
        self.username_entry.focus_set()

    def _toggle_password(self, event=None):
        if self.password_entry.cget("show") == "*":
            self.password_entry.config(show="")
            self.eye_icon.config(text="🐵")
        else:
            self.password_entry.config(show="*")
            self.eye_icon.config(text="🙈")

    def _toggle_extra_config(self, event=None):
        """Toggle the visibility of the extra configuration fields."""
        extra_entries = (
            self.hash_rounds_entry,
            self.salt_entry,
            self.local_clipboard_size_entry,
            self.default_file_download_location_entry,
            self.ssl_ca_bundle_entry,
        )
        if self.show_extra:
            focused = self.focus_get()
            if focused in extra_entries:
                self.login_button.focus_set()
            self.extra_frame_container.pack_forget()
            self.toggle_label.config(text="Enable Extra Config")
        else:
            self.extra_frame_container.pack(fill=tk.BOTH, expand=True)
            self.toggle_label.config(text="Hide Extra Config")
        self.show_extra = not self.show_extra
        self._sync_login_tab_order()

        self.update_idletasks()
        self.geometry("")
        self.update_idletasks()
        center_window(self)

    def _on_hover(self, event=None):
        """Change text color on hover."""
        self.toggle_label.config(fg=self.toggle_hover_color)

    def _on_leave(self, event=None):
        """Revert text color when not hovered."""
        self.toggle_label.config(fg=self.toggle_normal_color)

    def _bind_mousewheel(self):
        """Bind mouse wheel events to the canvas for scrolling."""
        if PLATFORM == WINDOWS:
            self.extra_canvas.bind_all("<MouseWheel>", self._on_mousewheel_windows)
        elif PLATFORM == MACOS:
            self.extra_canvas.bind_all("<MouseWheel>", self._on_mousewheel_mac)
        elif PLATFORM.startswith(LINUX):
            # Linux uses Button-4 and Button-5 for scroll up/down
            self.extra_canvas.bind_all("<Button-4>", self._on_mousewheel_linux)
            self.extra_canvas.bind_all("<Button-5>", self._on_mousewheel_linux)

    def _on_mousewheel_windows(self, event):
        """Handle mouse wheel scrolling on Windows."""
        self.extra_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def _on_mousewheel_mac(self, event):
        """Handle mouse wheel scrolling on macOS."""
        self.extra_canvas.yview_scroll(int(-1 * event.delta), "units")

    def _on_mousewheel_linux(self, event):
        """Handle mouse wheel scrolling on Linux."""
        if event.num == 4:
            self.extra_canvas.yview_scroll(-1, "units")
        elif event.num == 5:
            self.extra_canvas.yview_scroll(1, "units")

    def _on_extra_container_configure(self, event):
        """Adjust the width of the extra_frame as the container is resized."""
        canvas_width = event.width - self.scrollbar.winfo_width()
        self.extra_canvas.itemconfigure(self.extra_frame_window, width=canvas_width)

    @staticmethod
    def remove_trailing_slash(entry):
        return re.sub(r"/+$", "", entry)

    @staticmethod
    def is_positive_integer(value):
        if value.isdigit() and int(value) > 0:
            return True
        else:
            return False

    def on_login(self):
        # save data to config
        self.config.data["username"] = self.username_entry.get()
        self.config.data["password"] = self.password_entry.get()
        self.config.data["server_url"] = LoginForm.remove_trailing_slash(
            self.server_url_entry.get().strip()
        )
        self.config.data["cipher_enabled"] = self.cipher_var.get()
        self.config.data["notification"] = self.notification_var.get()

        # extra fields

        # Validate hash_rounds
        hash_rounds_input = self.hash_rounds_entry.get().strip()
        if not LoginForm.is_positive_integer(hash_rounds_input):
            CustomDialog(
                "Invalid Input\nHash Rounds must be a positive integer.",
                msg_type="error",
            ).mainloop()
            return  # retry login
        self.config.data["hash_rounds"] = int(hash_rounds_input)

        self.config.data["salt"] = self.salt_entry.get()
        self.config.data["save_password"] = self.save_password_var.get()

        # Validate max_clipboard_size_local_limit_bytes
        max_clipboard_size_local_limit_bytes_input = self.local_clipboard_size_entry.get().strip()
        if max_clipboard_size_local_limit_bytes_input == "":
            self.config.data["max_clipboard_size_local_limit_bytes"] = None
        else:
            if not LoginForm.is_positive_integer(max_clipboard_size_local_limit_bytes_input):
                CustomDialog(
                    "Invalid Input\nMax Clipboard Size Local Limit must be a positive integer.",
                    msg_type="error",
                ).mainloop()
                return  # retry login
            self.config.data["max_clipboard_size_local_limit_bytes"] = int(
                max_clipboard_size_local_limit_bytes_input
            )

        self.config.data["enable_image_sharing"] = self.enable_image_sharing_var.get()
        self.config.data["enable_file_sharing"] = self.enable_file_sharing_var.get()

        # Validate file download location
        default_file_download_location = self.default_file_download_location_entry.get().strip()
        if default_file_download_location == "":
            self.config.data["default_file_download_location"] = ""
        else:
            if not os.path.exists(default_file_download_location):
                CustomDialog(
                    "Invalid Input\nDefault File Download Location does not exist.",
                    msg_type="error",
                ).mainloop()
                return  # retry login
            self.config.data["default_file_download_location"] = default_file_download_location

        ssl_ca_bundle = self.ssl_ca_bundle_entry.get().strip()
        if ssl_ca_bundle:
            if not os.path.isfile(ssl_ca_bundle):
                CustomDialog(
                    "Invalid Input\nSSL CA bundle path is not a file or does not exist.",
                    msg_type="error",
                ).mainloop()
                return
        self.config.data["ssl_ca_bundle"] = ssl_ca_bundle

        # call login callback
        if self.on_login_callback:
            self.on_login_callback()

        self.close()

    def on_quit(self):
        if self.on_quit_callback:
            self.on_quit_callback()
        self.close()

    def close(self):
        self.destroy()
        gc.collect()
        time.sleep(0.5)
