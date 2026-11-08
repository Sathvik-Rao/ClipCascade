from cli.echo import Echo


class CustomDialog:
    def __init__(self, message, msg_type="", timeout=None, actions=None):
        self.message = message
        self.msg_type = msg_type.lower()
        self.timeout = timeout
        self.actions = actions
        self.result = None

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
        if self.actions:
            for index, (label, _) in enumerate(self.actions, 1):
                Echo(f"{index}. {label}")
            while True:
                try:
                    answer = input("Choose an option: ").strip()
                except EOFError:
                    return
                if answer.isdigit() and 1 <= int(answer) <= len(self.actions):
                    self.result = self.actions[int(answer) - 1][1]
                    return

    def close(self):
        pass
