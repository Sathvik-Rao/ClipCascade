class MessageBox:
    def askquestion(self, title, message):
        response = input(f"{title}\n{message} (y/n): ").strip().lower()
        return "yes" if (response.lower().strip() == "y") else "no"
