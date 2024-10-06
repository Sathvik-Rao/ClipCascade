class CustomDialog():
    def __init__(self, message, msg_type="info"):
        if msg_type == "success":
            print("✅", message)
        elif msg_type == "error":
            print("❌", message)
        elif msg_type == "warning":
            print("⚠️", message)
        else:
            print(message)
