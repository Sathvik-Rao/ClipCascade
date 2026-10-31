#!/usr/bin/env python3

# ClipCascade - A seamless clipboard syncing utility
# Repository: https://github.com/Sathvik-Rao/ClipCascade
#
# Author: Sathvik Rao Poladi
# License: GPL-3.0
#
# This script serves as the entry point for the ClipCascade application,
# initializing and running the core application logic.

import sys

from core.application import Application


class Main:
    def __init__(self):
        Application().run()

def main():
    try:
        Main()
    except KeyboardInterrupt:
        # Application.run() performs cleanup before the interrupt reaches here.
        # A console Ctrl+C is an expected exit, not an application error.
        sys.exit(130)

if __name__ == "__main__":
    main()
