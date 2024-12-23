import tkinter as tk
from tkinter import ttk
from tkinter import scrolledtext
import gc
import time


class CustomDialog(tk.Tk):
    def __init__(self, message, msg_type="info", timeout=None):
        super().__init__()
        self.message = message
        self.msg_type = msg_type.lower()
        self.timeout = timeout
        self.after_id = None

        self.style = ttk.Style(self)
        self.style.configure("TFrame", background="#f2f2f2")
        self.style.configure(
            "TLabel", background="#f2f2f2", foreground="#333333", font=("Arial", 11)
        )
        self.style.configure("Header.TLabel", font=("Arial", 14, "bold"))
        self.style.configure("TButton", font=("Arial", 11))

        self._configure_window()
        self._show_dialog()

        if self.timeout:
            self.after_id = self.after(self.timeout, self.close)

        # Allow closing with keyboard shortcuts
        self.bind("<Return>", lambda e: self.close())
        self.bind("<Escape>", lambda e: self.close())

    def _configure_window(self):
        """Configure the dialog window properties."""
        self.title("ClipCascade")
        self.geometry(
            "600x300+{}+{}".format(
                (self.winfo_screenwidth() - 600) // 2,
                (self.winfo_screenheight() - 300) // 2,
            )
        )
        self.attributes("-topmost", True)
        self.resizable(False, False)
        self.focus_force()

    def _show_dialog(self):
        """Display the appropriate dialog based on the message type."""
        type_config = {
            "success": ("Success", "green", "✔"),
            "error": ("Error", "red", "✖"),
            "warning": ("Warning", "orange", "⚠"),
            "info": ("Information", "blue", "ℹ"),
        }
        title, color, symbol = type_config.get(self.msg_type, ("Message", "black", "•"))

        # Create a main frame
        main_frame = ttk.Frame(self, padding="20 20 20 20")
        main_frame.pack(fill="both", expand=True)

        # Title frame with symbol and title
        title_frame = ttk.Frame(main_frame)
        title_frame.pack(pady=(0, 10), fill="x")

        symbol_label = ttk.Label(
            title_frame, text=symbol, font=("Arial", 18, "bold"), foreground=color
        )
        symbol_label.pack(side="left", padx=(0, 10))

        title_label = ttk.Label(
            title_frame, text=title, style="Header.TLabel", foreground=color
        )
        title_label.pack(side="left")

        # Message frame for scrolled text
        message_frame = ttk.Frame(main_frame)
        message_frame.pack(fill="both", expand=True, pady=10)

        # ScrolledText widget for the message
        self.text_widget = scrolledtext.ScrolledText(
            message_frame, wrap="word", font=("Arial", 11), width=70, height=8
        )
        self.text_widget.pack(fill="both", expand=True)

        # Insert the message and disable editing
        self.text_widget.insert("1.0", self.message)
        self.text_widget.config(state="disabled")

        # Button frame
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(pady=(10, 0))

        ok_button = ttk.Button(button_frame, text="OK", command=self.close, width=10)
        ok_button.pack()
        ok_button.focus_set()

    def close(self):
        if self.after_id:
            self.after_cancel(self.after_id)  # Cancel the after event if it exists
            self.after_id = None
        self.destroy()
        gc.collect()
        time.sleep(0.5)
