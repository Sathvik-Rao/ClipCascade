import webbrowser
from no_gui.info import CustomDialog

class TaskbarPanel:
    def __init__(
        self,
        on_connect_callback=None,
        on_disconnect_callback=None,
        on_logoff_callback=None,
    ):
        # Initial state: Connected
        self.is_connected = True
        
        while True:
            print("-" * 53)
            if self.is_connected:
                print("1. Disconnect")
            else:
                print("1. Connect")
            print("2. GitHub")
            print("3. Logoff and Quit")
            print("4. Quit")

            choice = input("Choice: \n")
            if choice == "1":
                if self.is_connected:
                    if on_disconnect_callback:
                        on_disconnect_callback()
                        self.is_connected = False
                else:
                    if on_connect_callback:
                        try:
                            on_connect_callback()
                        except Exception as e:
                            pass
                        self.is_connected = True
            elif choice == "2":
                webbrowser.open("https://github.com/Sathvik-Rao/ClipCascade")
            elif choice == "3":
                try:
                    if on_logoff_callback:
                        on_logoff_callback()
                    break
                except Exception as e:
                    CustomDialog(
                        f"An error occurred while logging off: {e}", msg_type="error"
                    )
            elif choice == "4":
                break
            else:
                print("Invalid choice")
