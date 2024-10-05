import re
import tkinter as tk


class LoginForm(tk.Tk):
    def __init__(
        self,
        username,
        password,
        server_url,
        websocket_url,
        cipher_enabled,
        notification,
        on_login_callback=None,
        on_quit_callback=None,
    ):
        super().__init__()
        self.on_login_callback = on_login_callback
        self.on_quit_callback = on_quit_callback

        self.withdraw()  # Hide the root window
        self.title("ClipCascade")

        # Set window size and center it
        window_width = 500
        window_height = 300
        screen_width = self.winfo_screenwidth()
        screen_height = self.winfo_screenheight()
        x = (screen_width // 2) - (window_width // 2)
        y = (screen_height // 2) - (window_height // 2)
        self.geometry(f"{window_width}x{window_height}+{x}+{y}")

        # Create a frame for the fields and arrange them in two columns
        self.field_frame = tk.Frame(self)
        self.field_frame.pack(padx=20, pady=20, fill=tk.X)

        # Username Field
        tk.Label(self.field_frame, text="Username").grid(
            row=0, column=0, padx=10, pady=5, sticky=tk.W
        )
        self.username_entry = tk.Entry(self.field_frame, width=50)
        self.username_entry.insert(0, username)
        self.username_entry.grid(row=0, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # Password Field
        tk.Label(self.field_frame, text="Password").grid(
            row=1, column=0, padx=10, pady=5, sticky=tk.W
        )
        self.password_frame = tk.Frame(self.field_frame)
        self.password_frame.grid(row=1, column=1, padx=10, pady=5, sticky=tk.W + tk.E)
        self.password_entry = tk.Entry(self.password_frame, show="*")
        self.password_entry.insert(0, password)
        self.password_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.eye_icon = tk.Label(self.password_frame, text="🙈", cursor="hand2")
        self.eye_icon.pack(side=tk.RIGHT)
        self.eye_icon.bind("<Button-1>", self.toggle_password)

        # Server URL Field
        tk.Label(self.field_frame, text="Server URL").grid(
            row=2, column=0, padx=10, pady=5, sticky=tk.W
        )
        self.server_url_entry = tk.Entry(self.field_frame)
        self.server_url_entry.insert(0, server_url)
        self.server_url_entry.grid(row=2, column=1, padx=10, pady=5, sticky=tk.W + tk.E)

        # WebSocket URL Field
        tk.Label(self.field_frame, text="WebSocket URL").grid(
            row=3, column=0, padx=10, pady=5, sticky=tk.W
        )
        self.websocket_url_entry = tk.Entry(self.field_frame)
        self.websocket_url_entry.insert(0, websocket_url)
        self.websocket_url_entry.grid(
            row=3, column=1, padx=10, pady=5, sticky=tk.W + tk.E
        )

        # Enable Cipher Checkbox
        self.cipher_var = tk.BooleanVar(value=cipher_enabled)
        self.cipher_checkbox = tk.Checkbutton(
            self, text="Enable Encryption(recommended)", variable=self.cipher_var
        )
        self.cipher_checkbox.pack(pady=3)

        # Enable Notification Checkbox
        self.notification_var = tk.BooleanVar(value=notification)
        self.notification_checkbox = tk.Checkbutton(
            self, text="Enable Notification", variable=self.notification_var
        )
        self.notification_checkbox.pack(pady=3)

        # Login Button
        self.login_button = tk.Button(self, text="Login", command=self.on_login)
        self.login_button.pack(pady=10)

        # Handle window close
        self.protocol("WM_DELETE_WINDOW", self.on_quit)

        self.deiconify()  # Show the root window

    def toggle_password(self, event=None):
        if self.password_entry.cget("show") == "*":
            self.password_entry.config(show="")
            self.eye_icon.config(text="🐵")
        else:
            self.password_entry.config(show="*")
            self.eye_icon.config(text="🙈")

    def on_login(self):
        username = self.username_entry.get()
        password = self.password_entry.get()
        server_url = self.server_url_entry.get()
        server_url = re.sub(r"/+$", "", server_url)
        websocket_url = self.websocket_url_entry.get()
        websocket_url = re.sub(r"/+$", "", websocket_url)
        cipher_enabled = self.cipher_var.get()
        notification = self.notification_var.get()

        if self.on_login_callback:
            self.on_login_callback(
                username,
                password,
                server_url,
                websocket_url,
                cipher_enabled,
                notification,
            )
        self.destroy()

    def on_quit(self):
        if self.on_quit_callback:
            self.on_quit_callback()
        self.destroy()
