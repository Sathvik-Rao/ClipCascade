import tkinter as tk


class CustomDialog(tk.Tk):
    def __init__(self, message, msg_type="info", timeout=None):
        super().__init__()
        self.message = str(message)
        self.break_string()
        self.msg_type = msg_type
        self.timeout = timeout

        self.title("ClipCascade")
        self.geometry(
            "600x200+{}+{}".format(
                (self.winfo_screenwidth() - 600) // 2,
                (self.winfo_screenheight() - 200) // 2,
            )
        )

        if self.msg_type == "success":
            self.show_success()
        elif self.msg_type == "error":
            self.show_error()
        elif self.msg_type == "warning":
            self.show_warning()
        else:
            self.show_info()

        if self.timeout:
            self.after(self.timeout, self.destroy)

    def show_success(self):
        tk.Label(self, text="Success", font=("Arial", 12, "bold"), fg="green").pack(
            pady=10
        )
        tk.Label(self, text=self.message).pack(pady=5)
        tk.Button(self, text="OK", command=self.destroy).pack(pady=10)

    def show_error(self):
        tk.Label(self, text="Error", font=("Arial", 12, "bold"), fg="red").pack(pady=10)
        tk.Label(self, text=self.message).pack(pady=5)
        tk.Button(self, text="OK", command=self.destroy).pack(pady=10)

    def show_warning(self):
        tk.Label(self, text="Warning", font=("Arial", 12, "bold"), fg="orange").pack(
            pady=10
        )
        tk.Label(self, text=self.message).pack(pady=5)
        tk.Button(self, text="OK", command=self.destroy).pack(pady=10)

    def show_info(self):
        tk.Label(self, text="Information", font=("Arial", 12, "bold"), fg="blue").pack(
            pady=10
        )
        tk.Label(self, text=self.message).pack(pady=5)
        tk.Button(self, text="OK", command=self.destroy).pack(pady=10)

    def break_string(self, line_length=70):
        lines = self.message.splitlines()
        wrapped_lines = []
        for line in lines:
            wrapped_lines.extend(
                [line[i : i + line_length] for i in range(0, len(line), line_length)]
            )
        self.message = "\n".join(wrapped_lines)
