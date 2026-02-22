from tkinter import messagebox
import tkinter as tk
from utils.window_manager import center_window

class MessageBox:
    def askquestion(self, title, message):
        parent = tk.Tk()
        parent.update_idletasks()
        parent.geometry("1x1+0+0")
        center_window(parent)
        parent.attributes("-topmost", True)
        result = messagebox.askquestion(title, message, parent=parent)
        parent.destroy()
        return result
