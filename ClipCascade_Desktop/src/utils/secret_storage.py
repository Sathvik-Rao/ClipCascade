"""Use the platform credential store without selecting a plaintext backend."""

SERVICE = "ClipCascade"


def backend():
    import sys

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
