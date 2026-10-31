import re
import threading
import webbrowser
import tkinter as tk
from tkinter import ttk, font, filedialog, messagebox
import gc
import time
import os

from utils.window_manager import center_window
from utils.notification_manager import NotificationManager
from core.config import Config
from core.clipboard_limit import (
    LIMIT_UNITS, NO_LOCAL_LIMIT, format_clipboard_limit, parse_clipboard_limit,
)
from gui.info import CustomDialog
from gui.tk_owner import GuiWindow
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


class LoginForm(GuiWindow):
    def watch_updates(self, checker):
        """Poll on Tk's UI thread; never touch Tk from the network worker."""
        def poll():
            status = checker.claim_alert(self.config.data.get("update_notifications", True))
            if status:
                message = f"ClipCascade {status[1]} is available (installed: {status[2]})."
                if self.focus_displayof() is not None:
                    if messagebox.askyesno("Update available", message + "\nOpen the download page?", parent=self):
                        webbrowser.open(status[3])
                else:
                    threading.Thread(
                        target=NotificationManager(self.config).notify,
                        args=("ClipCascade update available", message + " Use the tray menu to open the download page."),
                        kwargs={"preference": "update_notifications"}, daemon=True,
                    ).start()
            self._update_poll_id = self.after(1000, poll)
        self._update_poll_id = self.after(1000, poll)

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
        style.configure("Path.TButton", font=("Helvetica", 11), padding=(2, 1))

        # Draw a small trash icon without depending on platform emoji fonts.
        self.clear_path_icon = tk.PhotoImage(master=self, width=12, height=14)
        for rectangle in (
            (4, 0, 8, 1), (1, 2, 11, 3),
            (2, 4, 3, 12), (9, 4, 10, 12), (2, 12, 10, 13),
            (5, 5, 6, 10), (7, 5, 8, 10),
        ):
            self.clear_path_icon.put("#888888", to=rectangle)
        style.configure("TCheckbutton", font=("Helvetica", 13), padding=5)

        # Main frame with padding
        main_frame = ttk.Frame(self, padding=20)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title Label
        title_label = ttk.Label(
            main_frame,
            text="Log in",
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
            "Username used to log in to your ClipCascade account.\n"
            "\n"
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
            "Account password used for server authentication.\n"
            "\n"
            "When encryption is enabled, this password also derives your encryption key. Use the same password on every device.\n"
            "\n"
            "Note: after changing your account password, log in again on each device so their encryption keys match.",
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
            text="Enable encryption (recommended)",
            variable=self.cipher_var,
            takefocus=False,
        )
        self.cipher_checkbox.pack(pady=3, anchor=tk.W)
        self._add_tooltip(
            [self.cipher_checkbox],
            "Encrypts clipboard content on your device before sending it. Recommended.\n"
            "\n"
            "Note: all devices sharing clipboard data must use matching encryption settings, including the password, encryption salt, and key derivation iterations.",
        )

        # Notification Checkbox
        self.notification_var = tk.BooleanVar(value=self.config.data["notification"])
        self.notification_checkbox = ttk.Checkbutton(
            checks_frame,
            text="Show connection status notifications",
            variable=self.notification_var,
            takefocus=False,
        )
        self.notification_checkbox.pack(pady=3, anchor=tk.W)
        self._add_tooltip(
            [self.notification_checkbox],
            "Shows local notifications when the server connection is lost or restored.\n"
            "\n"
            "Turn this off if you prefer fewer popups.",
        )

        # Button frame
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(pady=(10, 0))

        # Login Button
        self.login_button = ttk.Button(button_frame, text="Log in", command=self.on_login)
        self.login_button.pack()

        # Extra Configurations Toggle Label
        self.show_extra = False
        self.toggle_normal_color = "#007acc"  # neutral blue with strong contrast
        self.toggle_hover_color = "#005a9e"  # slightly darker for hover feedback
        self.toggle_label = tk.Label(
            main_frame,
            text="Show advanced settings",
            fg=self.toggle_normal_color,
            cursor="hand2",
            font=font.Font(family="Helvetica", size=13, underline=True),
            takefocus=False,
        )
        self.toggle_label.pack(pady=(5, 10))
        self.toggle_label.bind("<Button-1>", self._toggle_extra_config)
        self._add_tooltip(
            [self.toggle_label],
            "Shows advanced settings for encryption, clipboard limits, sharing, download location, and certificate trust.\n"
            "\n"
            "Most users can keep the defaults.",
        )

        # hover effects for the toggle label
        self.toggle_label.bind("<Enter>", self._on_hover)
        self.toggle_label.bind("<Leave>", self._on_leave)

        # Extra Configuration Frame with Scrollbar
        self.extra_frame_container = ttk.Frame(main_frame)

        # Create a canvas inside the extra_frame_container
        self.extra_canvas = tk.Canvas(
            self.extra_frame_container,
            borderwidth=0,
            highlightthickness=0,
            background="#f0f0f0",
            takefocus=False,
        )

        # Add a vertical scrollbar to the canvas
        self.scrollbar = ttk.Scrollbar(
            self.extra_frame_container,
            orient="vertical",
            command=self.extra_canvas.yview,
            takefocus=False,
        )
        self.scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        # Reserve the scrollbar's space before the expanding canvas is packed.
        self.extra_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

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

        # Use the actual viewport width, including on the first layout pass.
        self.extra_canvas.bind("<Configure>", self._on_extra_canvas_configure)

        # Native labeled borders separate related advanced settings.
        for row, attribute, title in (
            (0, "security_settings_frame", "Security"),
            (1, "clipboard_settings_frame", "Clipboard sharing"),
            (2, "notification_settings_frame", "Notifications"),
        ):
            group = ttk.LabelFrame(self.extra_frame, text=title, padding=(10, 8))
            group.grid(row=row, column=0, sticky=tk.EW, pady=(0, 12))
            group.columnconfigure(1, weight=1)
            setattr(self, attribute, group)

        # Hash Rounds
        hash_rounds_label = ttk.Label(self.security_settings_frame, text="Key derivation iterations:")
        hash_rounds_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.hash_rounds_entry = ttk.Entry(self.security_settings_frame, width=50, font=("Helvetica", 13))
        self.hash_rounds_entry.insert(0, str(self.config.data["hash_rounds"]))
        self.hash_rounds_entry.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [hash_rounds_label, self.hash_rounds_entry],
            "Number of iterations used to derive your encryption key. Higher values increase resistance to password guessing, but take longer.\n"
            "\n"
            "Default: 664937. Keep the default unless you need a different value.\n"
            "\n"
            "Note: must be a positive integer and must match on every device.",
        )

        # Salt
        salt_label = ttk.Label(self.security_settings_frame, text="Encryption salt:")
        salt_label.grid(row=1, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.salt_entry = ttk.Entry(self.security_settings_frame, width=50, font=("Helvetica", 13))
        self.salt_entry.insert(0, self.config.data["salt"])
        self.salt_entry.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self._add_tooltip(
            [salt_label, self.salt_entry],
            "Optional extra text mixed into encryption key derivation. Letters, numbers, symbols, and spaces are allowed.\n"
            "\n"
            "Example: myCustomSalt123\n"
            "\n"
            "Note: use exactly the same salt on every device, including capitalization and spaces. Leave blank to keep the default. Changing it on only one device prevents decryption between devices.",
        )

        # Save Password Locally Checkbox
        save_password_label = ttk.Label(
            self.security_settings_frame,
            text="Store Password Locally\n(not recommended; \nonly works if encryption is disabled):",
        )
        save_password_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.save_password_var = tk.BooleanVar(value=self.config.data["save_password"])
        self.save_password_checkbox = ttk.Checkbutton(
            self.security_settings_frame,
            variable=self.save_password_var,
            takefocus=False,
        )
        self.save_password_checkbox.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [save_password_label, self.save_password_checkbox],
            "Stores your password locally for automatic login convenience.\n"
            "\n"
            "Note: only works when encryption is disabled. Not recommended on shared or untrusted devices.",
        )

        # Keep the saved preference in bytes while editing in readable units.
        local_clipboard_size_label = ttk.Label(
            self.clipboard_settings_frame, text="Local clipboard size limit:"
        )
        local_clipboard_size_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        limit_frame = ttk.Frame(self.clipboard_settings_frame)
        limit_frame.grid(row=0, column=1, padx=10, pady=5, sticky=tk.EW)
        limit_frame.columnconfigure(0, weight=1)
        amount, unit = format_clipboard_limit(self.config.data["max_clipboard_size_local_limit_bytes"])
        self.clipboard_limit_amount_var = tk.StringVar(value=amount)
        self.clipboard_limit_unit_var = tk.StringVar(value=unit)
        self.local_clipboard_size_entry = ttk.Entry(
            limit_frame, width=12, textvariable=self.clipboard_limit_amount_var,
            font=("Helvetica", 13),
        )
        self.local_clipboard_size_entry.grid(row=0, column=0, sticky=tk.EW)
        self.clipboard_limit_unit = ttk.Combobox(
            limit_frame, textvariable=self.clipboard_limit_unit_var,
            values=(NO_LOCAL_LIMIT, *LIMIT_UNITS), state="readonly", width=12,
        )
        self.clipboard_limit_unit.grid(row=0, column=1, padx=(6, 0), sticky=tk.EW)
        # Scroll the settings, without letting the combobox class binding edit
        # and immediately save the selected unit as the pointer passes over it.
        for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.clipboard_limit_unit.bind(sequence, self._on_clipboard_unit_mousewheel)
        self.clipboard_limit_error_var = tk.StringVar()
        ttk.Label(limit_frame, textvariable=self.clipboard_limit_error_var,
                  foreground="#b42318", wraplength=300).grid(
            row=1, column=0, columnspan=2, sticky=tk.W,
        )
        self.local_clipboard_size_entry.configure(
            state="disabled" if unit == NO_LOCAL_LIMIT else "normal"
        )
        self._add_tooltip(
            [local_clipboard_size_label, self.local_clipboard_size_entry, self.clipboard_limit_unit],
            "Limit incoming and outgoing clipboard content. Choose a number and unit, "
            "or leave blank for no local limit.\n\n1 KiB = 1024 bytes; 1 MiB = 1024 KiB. "
            "Decimals such as 1.5 MiB are supported and rounded to the nearest byte.\n\n"
            "Server and platform limits still apply.",
        )
        self.clipboard_limit_amount_var.trace_add("write", self._save_clipboard_limit)
        self.clipboard_limit_unit_var.trace_add("write", self._change_clipboard_limit_unit)

        for row, field, label, help_text in (
            (1, "send_clipboard", "Send Clipboard:", "Share clipboard changes from this device."),
            (2, "receive_clipboard", "Receive Clipboard:", "Apply clipboard updates from other devices."),
        ):
            variable = tk.BooleanVar(value=self.config.data[field])
            setattr(self, field + "_var", variable)
            label_widget = ttk.Label(self.clipboard_settings_frame, text=label)
            label_widget.grid(row=row, column=0, padx=(0, 10), pady=5, sticky=tk.W)
            checkbox = ttk.Checkbutton(self.clipboard_settings_frame, variable=variable, takefocus=False)
            checkbox.grid(row=row, column=1, padx=10, pady=5, sticky=tk.W)
            self._add_tooltip([label_widget, checkbox], help_text)

        # Enable Image Sharing Checkbox
        enable_image_sharing_label = ttk.Label(self.clipboard_settings_frame, text="Enable Image Sharing:")
        enable_image_sharing_label.grid(row=3, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.enable_image_sharing_var = tk.BooleanVar(
            value=self.config.data["enable_image_sharing"]
        )
        self.enable_image_sharing_checkbox = ttk.Checkbutton(
            self.clipboard_settings_frame,
            variable=self.enable_image_sharing_var,
            takefocus=False,
        )
        self.enable_image_sharing_checkbox.grid(row=3, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [enable_image_sharing_label, self.enable_image_sharing_checkbox],
            "Allows this device to send copied images to other devices.\n"
            "\n"
            "Note: turning this off does not prevent receiving images from other devices.",
        )

        # Enable File Sharing Checkbox
        enable_file_sharing_label = ttk.Label(self.clipboard_settings_frame, text="Enable File Sharing:")
        enable_file_sharing_label.grid(row=4, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.enable_file_sharing_var = tk.BooleanVar(value=self.config.data["enable_file_sharing"])
        self.enable_file_sharing_checkbox = ttk.Checkbutton(
            self.clipboard_settings_frame,
            variable=self.enable_file_sharing_var,
            takefocus=False,
        )
        self.enable_file_sharing_checkbox.grid(row=4, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [enable_file_sharing_label, self.enable_file_sharing_checkbox],
            "Allows this device to send copied or shared files to other devices.\n"
            "\n"
            "Note: turning this off does not prevent receiving files from other devices.",
        )

        # Default File Download Location
        default_file_download_location_label = ttk.Label(
            self.clipboard_settings_frame, text="Default download folder:"
        )
        default_file_download_location_label.grid(
            row=5, column=0, padx=(0, 10), pady=5, sticky=tk.W
        )
        download_path_frame = ttk.Frame(self.clipboard_settings_frame)
        download_path_frame.grid(row=5, column=1, padx=10, pady=5, sticky=tk.EW)
        download_path_frame.columnconfigure(0, weight=1)
        self.default_file_download_location_entry = ttk.Entry(
            download_path_frame, width=30, font=("Helvetica", 13)
        )
        self.default_file_download_location_entry.insert(
            0, self.config.data["default_file_download_location"]
        )
        self.default_file_download_location_entry.grid(row=0, column=0, sticky=tk.EW)
        self.download_folder_browse_button = ttk.Button(
            download_path_frame,
            text="Browse…",
            width=0,
            style="Path.TButton",
            command=lambda: self._browse_path(
                self.default_file_download_location_entry, directory=True
            ),
        )
        self.download_folder_browse_button.grid(row=0, column=1, padx=(4, 0))
        self.download_folder_clear_button = ttk.Button(
            download_path_frame,
            image=self.clear_path_icon,
            width=0,
            style="Path.TButton",
            command=lambda: self._clear_path(self.default_file_download_location_entry),
        )
        self.download_folder_clear_button.grid(row=0, column=2, padx=(4, 0))
        self._add_tooltip(
            [default_file_download_location_label, self.default_file_download_location_entry,
             self.download_folder_browse_button],
            "Optional default folder for saving incoming files. Type a path or use Browse… to select an existing folder.\n"
            "\n"
            "Examples:\n"
            "- Windows: C:\\Users\\YourName\\Downloads\n"
            "- macOS: /Users/yourname/Downloads\n"
            "- Linux: /home/yourname/Downloads\n"
            "\n"
            "Use the trash button or leave blank to choose a folder for each download.",
        )

        # SSL CA bundle (private / corporate PKI)
        ssl_ca_label = ttk.Label(self.security_settings_frame, text="Custom CA certificate bundle:")
        ssl_ca_label.grid(row=3, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        ca_path_frame = ttk.Frame(self.security_settings_frame)
        ca_path_frame.grid(row=3, column=1, padx=10, pady=5, sticky=tk.EW)
        ca_path_frame.columnconfigure(0, weight=1)
        self.ssl_ca_bundle_entry = ttk.Entry(
            ca_path_frame, width=30, font=("Helvetica", 13)
        )
        self.ssl_ca_bundle_entry.insert(
            0, self.config.data.get("ssl_ca_bundle") or ""
        )
        self.ssl_ca_bundle_entry.grid(row=0, column=0, sticky=tk.EW)
        self.ca_bundle_browse_button = ttk.Button(
            ca_path_frame,
            text="Browse…",
            width=0,
            style="Path.TButton",
            command=lambda: self._browse_path(self.ssl_ca_bundle_entry),
        )
        self.ca_bundle_browse_button.grid(row=0, column=1, padx=(4, 0))
        self.ca_bundle_clear_button = ttk.Button(
            ca_path_frame,
            image=self.clear_path_icon,
            width=0,
            style="Path.TButton",
            command=lambda: self._clear_path(self.ssl_ca_bundle_entry),
        )
        self.ca_bundle_clear_button.grid(row=0, column=2, padx=(4, 0))
        self._add_tooltip(
            [ssl_ca_label, self.ssl_ca_bundle_entry, self.ca_bundle_browse_button],
            "Path to a PEM-encoded certificate bundle for a private or internal certificate authority. Used to verify HTTPS/WSS connections.\n"
            "\n"
            "Type a path or use Browse… to select a file.\n"
            "\n"
            "Examples:\n"
            "- Windows: C:\\certs\\corp-root.pem\n"
            "- macOS/Linux: /etc/ssl/corp-root.pem\n"
            "\n"
            "Use the trash button or leave blank, then log in, to use default certificate trust.",
        )

        self._add_tooltip(
            [self.download_folder_clear_button],
            "Clear the default download folder.\nChoose a folder for each download instead.",
        )
        self._add_tooltip(
            [self.ca_bundle_clear_button],
            "Clear the custom CA certificate bundle.\nLog in to use default certificate trust.",
        )

        update_label = ttk.Label(self.notification_settings_frame, text="Notify when an update is available:")
        update_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.update_notifications_var = tk.BooleanVar(value=self.config.data["update_notifications"])
        update_checkbox = ttk.Checkbutton(
            self.notification_settings_frame, variable=self.update_notifications_var, takefocus=False,
        )
        update_checkbox.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [update_label, update_checkbox],
            "Checks at startup and once a day while running.\n"
            "Alerts once per new version each session. Enabled by default.",
        )

        clipboard_label = ttk.Label(self.notification_settings_frame, text="Notify when clipboard content is received:")
        clipboard_label.grid(row=1, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.clipboard_notifications_var = tk.BooleanVar(
            value=self.config.data["clipboard_notifications"]
        )
        clipboard_checkbox = ttk.Checkbutton(
            self.notification_settings_frame, variable=self.clipboard_notifications_var, takefocus=False,
        )
        clipboard_checkbox.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [clipboard_label, clipboard_checkbox],
            "Shows a notification for clipboard content received from another device.\n"
            "Includes a text preview, image dimensions, or file names.\n"
            "Clipboard content may appear on your lock screen. Disabled by default.",
        )

        download_label = ttk.Label(self.notification_settings_frame, text="Notify when downloads finish:")
        download_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.download_notifications_var = tk.BooleanVar(value=self.config.data["download_notifications"])
        download_checkbox = ttk.Checkbutton(
            self.notification_settings_frame, variable=self.download_notifications_var, takefocus=False,
        )
        download_checkbox.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W)
        self._add_tooltip(
            [download_label, download_checkbox],
            "Shows a notification after files are saved. Enabled by default.\n"
            "Saving progress and download failures remain visible when disabled.",
        )

        # Configure grid weights for extra_frame
        self.extra_frame.columnconfigure(0, weight=1)

        # Bind after initialization so opening the form never writes defaults.
        for field, variable in (
            ("notification", self.notification_var),
            ("update_notifications", self.update_notifications_var),
            ("download_notifications", self.download_notifications_var),
            ("clipboard_notifications", self.clipboard_notifications_var),
            ("save_password", self.save_password_var),
            ("send_clipboard", self.send_clipboard_var),
            ("receive_clipboard", self.receive_clipboard_var),
            ("enable_image_sharing", self.enable_image_sharing_var),
            ("enable_file_sharing", self.enable_file_sharing_var),
        ):
            variable.trace_add(
                "write", lambda *_, key=field, var=variable:
                self._save_preference(key, var.get())
            )
        self._preference_entries = []
        for field, entry in (
            ("default_file_download_location", self.default_file_download_location_entry),
        ):
            variable = tk.StringVar(value=entry.get())
            entry.configure(textvariable=variable)
            variable.trace_add(
                "write", lambda *_, key=field, var=variable:
                self._save_preference_entry(key, var.get())
            )
            self._preference_entries.append(variable)

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
        """Tab cycles through login fields and visible advanced entries/pickers.
        Checkboxes and chrome are excluded from keyboard focus."""
        extra_entries = (
            self.hash_rounds_entry,
            self.salt_entry,
            self.local_clipboard_size_entry,
            self.clipboard_limit_unit,
            self.default_file_download_location_entry,
            self.download_folder_browse_button,
            self.download_folder_clear_button,
            self.ssl_ca_bundle_entry,
            self.ca_bundle_browse_button,
            self.ca_bundle_clear_button,
        )
        for w in extra_entries:
            w.configure(takefocus=bool(self.show_extra) and (
                w is not self.local_clipboard_size_entry
                or self.clipboard_limit_unit_var.get() != NO_LOCAL_LIMIT
            ))

    def _clear_path(self, entry):
        # Entry deletion also updates its StringVar and saved device preference.
        entry.delete(0, tk.END)
        entry.focus_set()

    def _browse_path(self, entry, directory=False):
        current_path = os.path.expanduser(entry.get().strip())
        initial_dir = current_path if directory else os.path.dirname(current_path)
        if not os.path.isdir(initial_dir):
            initial_dir = os.path.expanduser("~")
        options = {"parent": self, "initialdir": initial_dir}
        try:
            if directory:
                selected = filedialog.askdirectory(
                    title="Select default download folder", mustexist=True, **options
                )
            else:
                selected = filedialog.askopenfilename(
                    title="Select custom CA certificate bundle",
                    filetypes=(
                        ("PEM certificates", "*.pem"),
                        ("CRT certificates", "*.crt"),
                        ("All files", "*"),
                    ),
                    **options,
                )
        except (tk.TclError, RuntimeError, OSError) as error:
            CustomDialog(
                f"Unable to open the path picker: {error}\n\n"
                "You can still enter the path manually.",
                msg_type="error",
            ).mainloop()
            return
        if selected:
            variable = entry.cget("textvariable")
            if variable:
                # Update once so download-folder preference saving never sees a
                # temporary empty path between deleting and inserting text.
                self.setvar(variable, selected)
            else:
                entry.delete(0, tk.END)
                entry.insert(0, selected)
            entry.focus_set()

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
            self.clipboard_limit_unit,
            self.default_file_download_location_entry,
            self.download_folder_browse_button,
            self.download_folder_clear_button,
            self.ssl_ca_bundle_entry,
            self.ca_bundle_browse_button,
            self.ca_bundle_clear_button,
        )
        if self.show_extra:
            focused = self.focus_get()
            if focused in extra_entries:
                self.login_button.focus_set()
            self.extra_frame_container.pack_forget()
            self.toggle_label.config(text="Show advanced settings")
        else:
            self.extra_frame_container.pack(fill=tk.BOTH, expand=True)
            self.toggle_label.config(text="Hide advanced settings")
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

    def _on_clipboard_unit_mousewheel(self, event):
        """Route wheel input to the settings instead of changing the unit."""
        if PLATFORM == WINDOWS:
            self._on_mousewheel_windows(event)
        elif PLATFORM == MACOS:
            self._on_mousewheel_mac(event)
        elif PLATFORM.startswith(LINUX):
            self._on_mousewheel_linux(event)
        return "break"

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

    def _on_extra_canvas_configure(self, event):
        """Keep the settings groups inside the canvas viewport when resized."""
        self.extra_canvas.itemconfigure(self.extra_frame_window, width=max(1, event.width))

    @staticmethod
    def remove_trailing_slash(entry):
        return re.sub(r"/+$", "", entry)

    def _save_preference(self, field, value):
        if not self.config.save_preferences({field: value}):
            CustomDialog("Unable to save device preferences.", msg_type="error").mainloop()

    def _change_clipboard_limit_unit(self, *_):
        unlimited = self.clipboard_limit_unit_var.get() == NO_LOCAL_LIMIT
        self.local_clipboard_size_entry.configure(state="disabled" if unlimited else "normal")
        if unlimited:
            self.clipboard_limit_amount_var.set("")
        else:
            self._save_clipboard_limit()
        self._sync_login_tab_order()

    def _save_clipboard_limit(self, *_):
        try:
            value = parse_clipboard_limit(
                self.clipboard_limit_amount_var.get(), self.clipboard_limit_unit_var.get()
            )
        except ValueError as error:
            self.clipboard_limit_error_var.set(str(error))
            return  # Incomplete edits must not overwrite the last saved limit.
        self.clipboard_limit_error_var.set("")
        self._save_preference("max_clipboard_size_local_limit_bytes", value)

    def _save_preference_entry(self, field, value):
        value = value.strip()
        if field == "max_clipboard_size_local_limit_bytes":
            if value and not self.is_positive_integer(value):
                return  # Keep incomplete/invalid edits out of persistent settings.
            value = int(value) if value else None
        elif value and not os.path.isdir(value):
            return
        self._save_preference(field, value)

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
        self.config.data["update_notifications"] = self.update_notifications_var.get()
        self.config.data["download_notifications"] = self.download_notifications_var.get()
        self.config.data["clipboard_notifications"] = self.clipboard_notifications_var.get()

        # extra fields

        # Validate hash_rounds
        hash_rounds_input = self.hash_rounds_entry.get().strip()
        if not LoginForm.is_positive_integer(hash_rounds_input):
            CustomDialog(
                "Invalid Input\nKey derivation iterations must be a positive integer.",
                msg_type="error",
            ).mainloop()
            return  # retry login
        self.config.data["hash_rounds"] = int(hash_rounds_input)

        self.config.data["salt"] = self.salt_entry.get()
        self.config.data["save_password"] = self.save_password_var.get()

        try:
            self.config.data["max_clipboard_size_local_limit_bytes"] = parse_clipboard_limit(
                self.clipboard_limit_amount_var.get(), self.clipboard_limit_unit_var.get()
            )
        except ValueError as error:
            CustomDialog(f"Invalid Input\n{error}", msg_type="error").mainloop()
            return

        self.config.data["send_clipboard"] = self.send_clipboard_var.get()
        self.config.data["receive_clipboard"] = self.receive_clipboard_var.get()
        self.config.data["enable_image_sharing"] = self.enable_image_sharing_var.get()
        self.config.data["enable_file_sharing"] = self.enable_file_sharing_var.get()

        # Validate file download location
        default_file_download_location = self.default_file_download_location_entry.get().strip()
        if default_file_download_location == "":
            self.config.data["default_file_download_location"] = ""
        else:
            if not os.path.isdir(default_file_download_location):
                CustomDialog(
                    "Invalid Input\nDefault download folder does not exist.",
                    msg_type="error",
                ).mainloop()
                return  # retry login
            self.config.data["default_file_download_location"] = default_file_download_location

        ssl_ca_bundle = self.ssl_ca_bundle_entry.get().strip()
        if ssl_ca_bundle:
            if not os.path.isfile(ssl_ca_bundle):
                CustomDialog(
                    "Invalid Input\nCustom CA certificate bundle path is not a file or does not exist.",
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
        if getattr(self, "_update_poll_id", None):
            self.after_cancel(self._update_poll_id)
            self._update_poll_id = None
        self.destroy()
        gc.collect()
        time.sleep(0.5)
