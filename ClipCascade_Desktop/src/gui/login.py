import re
import tkinter as tk
from tkinter import ttk, font
import gc
import time

from core.config import Config
from gui.info import CustomDialog
from core.constants import *


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
            main_frame, text="Please Log In", font=("Helvetica", 16, "bold")
        )
        title_label.pack(pady=(0, 10))

        # Create a frame for the fields
        self.field_frame = ttk.Frame(main_frame)
        self.field_frame.pack(padx=10, pady=10, fill=tk.X)

        # Username
        user_label = ttk.Label(self.field_frame, text="Username:")
        user_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.username_entry = ttk.Entry(
            self.field_frame, width=50, font=("Helvetica", 13)
        )
        self.username_entry.insert(0, self.config.data["username"])
        self.username_entry.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

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

        self.eye_icon = ttk.Label(self.password_frame, text="🙈", cursor="hand2")
        self.eye_icon.pack(side=tk.RIGHT, padx=(5, 0))
        self.eye_icon.bind("<Button-1>", self._toggle_password)

        # Server URL
        server_label = ttk.Label(self.field_frame, text="Server URL:")
        server_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.server_url_entry = ttk.Entry(
            self.field_frame, width=50, font=("Helvetica", 13)
        )
        self.server_url_entry.insert(0, self.config.data["server_url"])
        self.server_url_entry.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # WebSocket URL
        ws_label = ttk.Label(self.field_frame, text="WebSocket URL:")
        ws_label.grid(row=3, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.websocket_url_entry = ttk.Entry(
            self.field_frame, width=50, font=("Helvetica", 13)
        )
        self.websocket_url_entry.insert(0, self.config.data["websocket_url"])
        self.websocket_url_entry.grid(
            row=3, column=1, padx=10, pady=5, sticky=tk.W + tk.E
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
        )
        self.cipher_checkbox.pack(pady=3, anchor=tk.W)

        # Notification Checkbox
        self.notification_var = tk.BooleanVar(value=self.config.data["notification"])
        self.notification_checkbox = ttk.Checkbutton(
            checks_frame, text="Enable Notification", variable=self.notification_var
        )
        self.notification_checkbox.pack(pady=3, anchor=tk.W)

        # Button frame
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(pady=(10, 0))

        # Login Button
        self.login_button = ttk.Button(
            button_frame, text="Login", command=self.on_login
        )
        self.login_button.pack()

        # Extra Configurations Toggle Label
        self.show_extra = False  # State to track visibility
        self.toggle_label = tk.Label(
            main_frame,
            text="Enable Extra Config",
            fg="blue",
            cursor="hand2",
            font=font.Font(family="Helvetica", size=13, underline=True),
        )
        self.toggle_label.pack(pady=(5, 10))
        self.toggle_label.bind("<Button-1>", self._toggle_extra_config)

        # hover effects for the toggle label
        self.toggle_label.bind("<Enter>", self._on_hover)
        self.toggle_label.bind("<Leave>", self._on_leave)

        # Extra Configuration Frame with Scrollbar
        self.extra_frame_container = ttk.Frame(main_frame)
        # Initially hide the extra configuration frame
        self.extra_frame_container.pack_forget()

        # Create a canvas inside the extra_frame_container
        self.extra_canvas = tk.Canvas(
            self.extra_frame_container, borderwidth=0, background="#f0f0f0"
        )
        self.extra_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Add a vertical scrollbar to the canvas
        self.scrollbar = ttk.Scrollbar(
            self.extra_frame_container,
            orient="vertical",
            command=self.extra_canvas.yview,
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
            lambda event: self.extra_canvas.configure(
                scrollregion=self.extra_canvas.bbox("all")
            ),
        )

        # Bind a configure event to the container to adjust the width
        self.extra_frame_container.bind(
            "<Configure>", self._on_extra_container_configure
        )

        # Subscription Destination
        subscription_label = ttk.Label(
            self.extra_frame, text="Subscription Destination:"
        )
        subscription_label.grid(row=0, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.subscription_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.subscription_entry.insert(0, self.config.data["subscription_destination"])
        self.subscription_entry.grid(
            row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )

        # Send Destination
        send_label = ttk.Label(self.extra_frame, text="Send Destination:")
        send_label.grid(row=1, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.send_entry = ttk.Entry(self.extra_frame, width=50, font=("Helvetica", 13))
        self.send_entry.insert(0, self.config.data["send_destination"])
        self.send_entry.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # Login URL
        login_label = ttk.Label(self.extra_frame, text="Login URL:")
        login_label.grid(row=2, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.login_url_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.login_url_entry.insert(0, self.config.data["login_url"])
        self.login_url_entry.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # Logout URL
        logout_label = ttk.Label(self.extra_frame, text="Logout URL:")
        logout_label.grid(row=3, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.logout_url_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.logout_url_entry.insert(0, self.config.data["logout_url"])
        self.logout_url_entry.grid(row=3, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # Maxsize URL
        maxsize_label = ttk.Label(self.extra_frame, text="Maxsize URL:")
        maxsize_label.grid(row=4, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.maxsize_url_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.maxsize_url_entry.insert(0, self.config.data["maxsize_url"])
        self.maxsize_url_entry.grid(
            row=4, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )

        # Hash Rounds
        hash_rounds_label = ttk.Label(self.extra_frame, text="Hash Rounds:")
        hash_rounds_label.grid(row=5, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.hash_rounds_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.hash_rounds_entry.insert(0, str(self.config.data["hash_rounds"]))
        self.hash_rounds_entry.grid(
            row=5, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )

        # Salt
        salt_label = ttk.Label(self.extra_frame, text="Salt:")
        salt_label.grid(row=6, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.salt_entry = ttk.Entry(self.extra_frame, width=50, font=("Helvetica", 13))
        self.salt_entry.insert(0, self.config.data["salt"])
        self.salt_entry.grid(row=6, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # Save Password Locally Checkbox
        save_password_label = ttk.Label(
            self.extra_frame, text="Store Password Locally\n(not recommended):"
        )
        save_password_label.grid(row=7, column=0, padx=(0, 10), pady=5, sticky=tk.W)
        self.save_password_var = tk.BooleanVar(value=self.config.data["save_password"])
        self.save_password_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.save_password_var,
        )
        self.save_password_checkbox.grid(row=7, column=1, padx=10, pady=5, sticky=tk.W)

        # Maximum Clipboard Size - Local Limit
        local_clipboard_size_label = ttk.Label(
            self.extra_frame, text="Maximum Clipboard Size\nLocal Limit (in bytes):"
        )
        local_clipboard_size_label.grid(
            row=8, column=0, padx=(0, 10), pady=5, sticky=tk.W
        )
        self.local_clipboard_size_entry = ttk.Entry(
            self.extra_frame, width=50, font=("Helvetica", 13)
        )
        self.local_clipboard_size_entry.insert(
            0, str(self.config.data["max_clipboard_size_local_limit_bytes"] or "")
        )
        self.local_clipboard_size_entry.grid(
            row=8, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )

        # Enable Image Sharing Checkbox
        enable_image_sharing_label = ttk.Label(
            self.extra_frame, text="Enable Image Sharing:"
        )
        enable_image_sharing_label.grid(
            row=9, column=0, padx=(0, 10), pady=5, sticky=tk.W
        )
        self.enable_image_sharing_var = tk.BooleanVar(
            value=self.config.data["enable_image_sharing"]
        )
        self.enable_image_sharing_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.enable_image_sharing_var,
        )
        self.enable_image_sharing_checkbox.grid(
            row=9, column=1, padx=10, pady=5, sticky=tk.W
        )

        # Enable File Sharing Checkbox
        enable_file_sharing_label = ttk.Label(
            self.extra_frame, text="Enable File Sharing:"
        )
        enable_file_sharing_label.grid(
            row=10, column=0, padx=(0, 10), pady=5, sticky=tk.W
        )
        self.enable_file_sharing_var = tk.BooleanVar(
            value=self.config.data["enable_file_sharing"]
        )
        self.enable_file_sharing_checkbox = ttk.Checkbutton(
            self.extra_frame,
            variable=self.enable_file_sharing_var,
        )
        self.enable_file_sharing_checkbox.grid(
            row=10, column=1, padx=10, pady=5, sticky=tk.W
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

        # Center the window on the screen
        self._center_window()

        self.deiconify()  # Show the root window

    def _center_window(self):
        """Centers the window on the screen based on its current size."""
        self.update_idletasks()  # Ensure accurate dimensions
        window_width = self.winfo_width()
        window_height = self.winfo_height()
        screen_width = self.winfo_screenwidth()
        screen_height = self.winfo_screenheight()

        # Calculate position
        x = (screen_width // 2) - (window_width // 2)
        y = (screen_height // 2) - (window_height // 2)

        # Enforce maximum height if needed
        if window_height > self.max_window_height:
            window_height = self.max_window_height

        # Always set geometry to the current (or adjusted) size and center it
        self.geometry(f"{window_width}x{window_height}+{x}+{y}")

    def _toggle_password(self, event=None):
        if self.password_entry.cget("show") == "*":
            self.password_entry.config(show="")
            self.eye_icon.config(text="🐵")
        else:
            self.password_entry.config(show="*")
            self.eye_icon.config(text="🙈")

    def _toggle_extra_config(self, event=None):
        """Toggle the visibility of the extra configuration fields."""
        if self.show_extra:
            self.extra_frame_container.pack_forget()
            self.toggle_label.config(text="Enable Extra Config")
        else:
            self.extra_frame_container.pack(fill=tk.BOTH, expand=True)
            self.toggle_label.config(text="Hide Extra Config")
        self.show_extra = not self.show_extra

        self.update_idletasks()
        self.geometry("")
        self.update_idletasks()
        self._center_window()

    def _on_hover(self, event=None):
        """Change text color on hover."""
        self.toggle_label.config(fg="dark blue")

    def _on_leave(self, event=None):
        """Revert text color when not hovered."""
        self.toggle_label.config(fg="blue")

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
        self.config.data["websocket_url"] = LoginForm.remove_trailing_slash(
            self.websocket_url_entry.get().strip()
        )
        self.config.data["cipher_enabled"] = self.cipher_var.get()
        self.config.data["notification"] = self.notification_var.get()

        # extra fields
        self.config.data["subscription_destination"] = LoginForm.remove_trailing_slash(
            self.subscription_entry.get().strip()
        )
        self.config.data["send_destination"] = LoginForm.remove_trailing_slash(
            self.send_entry.get().strip()
        )
        self.config.data["login_url"] = LoginForm.remove_trailing_slash(
            self.login_url_entry.get().strip()
        )
        self.config.data["logout_url"] = LoginForm.remove_trailing_slash(
            self.logout_url_entry.get().strip()
        )
        self.config.data["maxsize_url"] = LoginForm.remove_trailing_slash(
            self.maxsize_url_entry.get().strip()
        )

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
        max_clipboard_size_local_limit_bytes_input = (
            self.local_clipboard_size_entry.get().strip()
        )
        if max_clipboard_size_local_limit_bytes_input == "":
            self.config.data["max_clipboard_size_local_limit_bytes"] = None
        else:
            if not LoginForm.is_positive_integer(
                max_clipboard_size_local_limit_bytes_input
            ):
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
