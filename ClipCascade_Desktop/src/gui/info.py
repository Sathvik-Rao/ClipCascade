import tkinter as tk
from tkinter import ttk
from tkinter import scrolledtext, messagebox
import gc
import time

from utils.window_manager import center_window
from gui.tk_owner import GuiWindow
from core.constants import *


class CustomDialog(GuiWindow):
    def __init__(self, message, msg_type="info", timeout=None, on_dont_show_again=None, actions=None):
        super().__init__()
        self.message = message
        self.msg_type = msg_type.lower()
        self.timeout = timeout
        self.after_id = None
        self.on_dont_show_again = on_dont_show_again
        self.actions = actions
        self.result = None
        self.dont_show_again = tk.BooleanVar(master=self, value=False)

        self.style = ttk.Style(self)
        # All windows share one Tcl interpreter, so default ttk styles are
        # global. Scope dialog fonts and inherit native light/dark theme colors.
        self.style.configure("Dialog.TFrame")
        self.style.configure(
            "Dialog.TLabel", font=("Arial", 11)
        )
        self.style.configure("Header.Dialog.TLabel", font=("Arial", 14, "bold"))
        self.style.configure("Dialog.TButton", font=("Arial", 11))
        self.style.configure(
            "Dialog.TCheckbutton", font=("Arial", 11),
        )

        self._show_dialog()
        self._configure_window()

        if self.timeout:
            self.after_id = self.after(self.timeout, self.close)

        # Allow closing with keyboard shortcuts
        self.bind("<Return>", self._on_return)
        self.bind("<Escape>", lambda e: self.close())
        self.protocol("WM_DELETE_WINDOW", self.close)

    def _configure_window(self):
        """Configure the dialog window properties."""
        self.title("ClipCascade")
        # Measure after creating the widgets so fonts, display scaling, and
        # the optional checkbox cannot squeeze the OK button out of view.
        self.update_idletasks()
        height = max(300, self.winfo_reqheight())
        self.geometry(
            "600x{}+{}+{}".format(
                height,
                (self.winfo_screenwidth() - 600) // 2,
                (self.winfo_screenheight() - height) // 2,
            )
        )
        self.update_idletasks()
        center_window(self)
        self.attributes("-topmost", True)
        self.resizable(False, False)
        self.focus_force()

        if PLATFORM == MACOS:
            self.after(100, self._macos_restore_focus)

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
        main_frame = ttk.Frame(self, padding="20 20 20 20", style="Dialog.TFrame")
        main_frame.pack(fill="both", expand=True)
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)

        # Title frame with symbol and title
        title_frame = ttk.Frame(main_frame, style="Dialog.TFrame")
        title_frame.grid(row=0, column=0, pady=(0, 10), sticky="ew")

        symbol_label = ttk.Label(
            title_frame, text=symbol, font=("Arial", 18, "bold"), foreground=color,
            style="Dialog.TLabel",
        )
        symbol_label.pack(side="left", padx=(0, 10))

        title_label = ttk.Label(title_frame, text=title, style="Header.Dialog.TLabel", foreground=color)
        title_label.pack(side="left")

        # Message frame for scrolled text
        message_frame = ttk.Frame(main_frame, style="Dialog.TFrame")
        message_frame.grid(row=1, column=0, sticky="nsew", pady=10)

        # ScrolledText widget for the message
        self.text_widget = scrolledtext.ScrolledText(
            message_frame, wrap="word", font=("Arial", 11), width=70, height=8
        )
        self.text_widget.pack(fill="both", expand=True)

        # Insert the message and disable editing
        self.text_widget.insert("1.0", self.message)
        self.text_widget.config(state="disabled")

        if self.on_dont_show_again is not None:
            ttk.Checkbutton(
                main_frame,
                text="Don't show this again",
                variable=self.dont_show_again,
                command=self._cancel_timeout,
                style="Dialog.TCheckbutton",
            ).grid(row=2, column=0, sticky="w")

        # Button frame
        button_frame = ttk.Frame(main_frame, style="Dialog.TFrame")
        button_frame.grid(row=3, column=0, pady=(10, 0))

        for index, (label, value) in enumerate(self.actions or [("OK", None)]):
            button = ttk.Button(
                button_frame, text=label, command=lambda choice=value: self._choose(choice),
                width=12, style="Dialog.TButton",
            )
            button.pack(side="left", padx=4)
            if index == 0:
                button.focus_set()

    def _choose(self, value):
        self.result = value
        self.close()

    def _on_return(self, event):
        focused = self.focus_get()
        if isinstance(focused, ttk.Button):
            focused.invoke()
        elif self.actions:
            self._choose(self.actions[0][1])
        else:
            self.close()
        return "break"

    def _macos_restore_focus(self):
        """Force macOS to properly activate and focus the dialog."""
        try:
            from AppKit import NSApplication
            app = NSApplication.sharedApplication()
            app.activateIgnoringOtherApps_(True)
        except ImportError:
            pass
        self.lift()
        self.focus_force()

    def _cancel_timeout(self):
        if self.after_id:
            self.after_cancel(self.after_id)  # Cancel the after event if it exists
            self.after_id = None

    def close(self):
        self._cancel_timeout()
        if self.on_dont_show_again is not None and self.dont_show_again.get():
            if not self.on_dont_show_again():
                messagebox.showerror(
                    "ClipCascade", "Unable to save device preferences. Please try again.",
                    parent=self,
                )
                return
        self.destroy()
        gc.collect()
        time.sleep(0.5)
