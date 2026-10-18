import re

Byte = {"LF": "\x0A", "NULL": "\x00"}


class Frame:

    def __init__(self, command, headers, body):
        self.command = command
        self.headers = headers
        self.body = "" if body is None else body

    def __str__(self):
        # STOMP content-length counts UTF-8 bytes, not Python characters.
        headers = dict(self.headers)
        headers["content-length"] = str(len(self.body.encode("utf-8")))
        lines = [self.command]
        lines.extend(f"{name}:{value}" for name, value in headers.items())
        return Byte["LF"].join(lines) + "\n\n" + self.body

    @staticmethod
    def unmarshall_single(data):
        """Parse one complete frame without truncating multiline or UTF-8 bodies."""
        try:
            if isinstance(data, str):
                data = data.encode("utf-8")
            if not isinstance(data, bytes):
                return None
            # CRLF is allowed for header line endings, but body bytes are opaque.
            separator = re.search(b"\r?\n\r?\n", data)
            if separator is None:
                return None
            lines = data[:separator.start()].decode("utf-8").splitlines()
            if not lines or not lines[0].strip():
                return None
            command = lines[0].strip()
            headers = {}
            for line in lines[1:]:
                key, value = line.split(":", 1)
                headers.setdefault(key, value)
            body = data[separator.end():]
            if "content-length" in headers:
                length = int(headers["content-length"])
                if length < 0 or len(body) <= length or body[length:length + 1] != b"\x00":
                    return None
                body = body[:length]
            else:
                end = body.find(b"\x00")
                if end < 0:
                    return None
                body = body[:end]
            return Frame(command, headers, body.decode("utf-8"))
        except (ValueError, TypeError, UnicodeError):
            return None

    @staticmethod
    def marshall(command, headers, body):
        return str(Frame(command, headers, body)) + Byte["NULL"]
