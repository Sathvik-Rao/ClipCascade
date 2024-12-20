from tkinter import messagebox


class MessageBox:
    def askquestion(self, title, message):
        return messagebox.askquestion(title, message)
