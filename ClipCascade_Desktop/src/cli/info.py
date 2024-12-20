from cli.echo import Echo


class CustomDialog:
    def __init__(self, message, msg_type="", timeout=None):
        self.message = message
        self.msg_type = msg_type.lower()
        self.timeout = timeout

    def mainloop(self):
        if self.msg_type == "success":
            Echo("✅", self.message)
        elif self.msg_type == "error":
            Echo("❌", self.message)
        elif self.msg_type == "warning":
            Echo("⚠️", self.message)
        elif self.msg_type == "info":
            Echo("ℹ", self.message)
        else:
            Echo(self.message)

    def close(self):
        pass
