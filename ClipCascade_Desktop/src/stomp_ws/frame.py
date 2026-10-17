from urllib.parse import urlparse

Byte = {"LF": "\x0A", "NULL": "\x00"}


class Frame:

    def __init__(self, command, headers, body):
        self.command = command
        self.headers = headers
        self.body = "" if body is None else body

    def __str__(self):
        lines = [self.command]
        skipContentLength = "content-length" in self.headers
        if skipContentLength:
            del self.headers["content-length"]

        for name in self.headers:
            value = self.headers[name]
            lines.append("" + name + ":" + value)

        if self.body is not None and not skipContentLength:
            lines.append("content-length:" + str(len(self.body)))

        lines.append(Byte["LF"] + self.body)
        return Byte["LF"].join(lines)

    @staticmethod
    def unmarshall_single(data):
        # A single malformed frame should not kill the receive thread.
        # Return None so callers can skip the frame without losing the connection.
        try:
            if data is None:
                return None
            lines = data.split(Byte["LF"])
            if not lines:
                return None

            command = lines[0].strip()
            if not command:
                return None
            headers = {}

            # get all headers
            i = 1
            while i < len(lines) and lines[i] != "":
                # Skip header lines that don't contain a ':' separator instead of crashing.
                if ":" in lines[i]:
                    (key, value) = lines[i].split(":", 1)
                    headers[key] = value
                i += 1

            # set body to None if no body line exists or the body marker indicates empty
            if i + 1 >= len(lines):
                body = None
            else:
                raw_body = lines[i + 1]
                body = None if raw_body == Byte["NULL"] or raw_body == "" else raw_body[:-1]

            return Frame(command, headers, body)
        except Exception:
            return None

    @staticmethod
    def marshall(command, headers, body):
        return str(Frame(command, headers, body)) + Byte["NULL"]
