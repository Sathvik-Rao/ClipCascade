"""Convert the clipboard limit editor to the existing byte-based preference."""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re

LIMIT_UNITS = {"Bytes": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3}
NO_LOCAL_LIMIT = "No local limit"
MAX_LIMIT_BYTES = 2 ** 53 - 1


def parse_clipboard_limit(amount, unit):
    if unit == NO_LOCAL_LIMIT or (unit in LIMIT_UNITS and not amount.strip()):
        return None
    if unit not in LIMIT_UNITS or not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", amount.strip()):
        raise ValueError("Enter a positive number, or leave blank for no local limit.")
    try:
        value = Decimal(amount.strip()) * LIMIT_UNITS[unit]
        if value <= 0 or value > MAX_LIMIT_BYTES:
            raise ValueError("Choose a limit between 1 byte and 8 PiB (exclusive).")
        result = int(value.to_integral_value(rounding=ROUND_HALF_UP))
        if result < 1:
            raise ValueError("The limit must be at least 1 byte.")
        return result
    except InvalidOperation as error:
        raise ValueError("Enter a valid clipboard size limit.") from error


def format_clipboard_limit(value):
    # Preserve the original byte value and blank-input behavior on every load.
    return ("" if value is None or value == "" else str(int(value))), "Bytes"
