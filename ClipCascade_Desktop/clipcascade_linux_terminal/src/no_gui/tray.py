import webbrowser
from no_gui.info import CustomDialog


class TaskbarPanel:
    def __init__(
        self,
        on_connect_callback=None,
        on_disconnect_callback=None,
        on_logoff_callback=None,
        new_version_available=None,
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
            if new_version_available[0]:
                print(
                    f"5. Update ({new_version_available[2]} ➞ {new_version_available[1]})"
                )

            choice = input("Choice: \n")
            if choice == "1":  # Connect or Disconnect
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
            elif choice == "2":  # GitHub
                self.open_webbrowser("https://github.com/Sathvik-Rao/ClipCascade")
            elif choice == "3":  # Logoff and Quit
                try:
                    if on_logoff_callback:
                        on_logoff_callback()
                    break
                except Exception as e:
                    CustomDialog(
                        f"An error occurred while logging off: {e}", msg_type="error"
                    )
            elif choice == "4":  # Quit
                break
            elif choice == "5" and new_version_available[0]:  # Update
                self.open_webbrowser(
                    "https://github.com/Sathvik-Rao/ClipCascade/releases/latest"
                )
            else:
                print("Invalid choice")

    def open_webbrowser(self, url):
        try:
            webbrowser.open(url)
        except Exception as e:
            CustomDialog(
                f"Failed to open the browser. Here is the URL: {url}\nError: {e}",
                msg_type="error",
            )
