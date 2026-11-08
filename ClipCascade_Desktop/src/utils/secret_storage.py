"""Use the platform credential store without selecting a plaintext backend."""

import logging
import sys
import time

SERVICE = "ClipCascade"

# Help for the GUI credential storage tooltip.
STORAGE_HELP = (
    "Off (default): saved login credentials are stored in the local DATA file, "
    "without OS credential-store protection.\n\n"
    "On: store saved login credentials in Windows Credential Manager, macOS Keychain, "
    "or a Linux Secret Service keyring instead of DATA. "
    "This also protects saved session credentials and encryption keys; "
    "it does not change whether your password is remembered. "
    "This choice is saved immediately and takes effect after your next successful manual login. "
    "Closing the login form keeps the existing saved credentials in their current location.\n\n"
    "Linux: starting before OS login may leave the credential service unavailable. "
    "A locked keyring may show an unlock popup when a desktop session is available, "
    "including after automatic login.\n\n"
    "macOS: an updated app may ask you to allow Keychain access again. "
    "Allow access to continue using the saved login."
)


def is_service_unavailable(error):
    """Recognize availability failures, not evidence that startup is in progress."""
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if sys.platform == "win32" and getattr(error, "winerror", None) == 1312:
            return True  # ERROR_NO_SUCH_LOGON_SESSION
        if sys.platform.startswith("linux"):
            try:
                from secretstorage.exceptions import SecretServiceNotAvailableException
            except ImportError:
                pass
            else:
                if isinstance(error, SecretServiceNotAvailableException):
                    return True
            # keyring's priority check raises this without a chained exception.
            if isinstance(error, RuntimeError) and str(error) == (
                "The Secret Service daemon is neither running nor activatable through D-Bus"
            ):
                return True
        error = error.__cause__ or error.__context__
    return False


def get_password(ref):
    """Allow normal OS prompts; retry only recognized service availability errors."""
    delays = (1, 2)
    for attempt in range(len(delays) + 1):
        try:
            return backend().get_password(SERVICE, ref)
        except Exception as error:
            if attempt == len(delays) or not is_service_unavailable(error):
                raise
            logging.info("Credential service unavailable; retrying saved credential access")
            time.sleep(delays[attempt])


def backend():
    if sys.platform == "darwin":
        from keyring.backends.macOS import Keyring
    elif sys.platform == "win32":
        from keyring.backends.Windows import WinVaultKeyring as Keyring
    else:
        from keyring.backends.SecretService import Keyring

    store = Keyring()
    if store.priority <= 0:
        raise RuntimeError("Platform credential store is unavailable")
    return store
