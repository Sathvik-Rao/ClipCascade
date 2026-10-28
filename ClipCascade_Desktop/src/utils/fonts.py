"""Runtime UI font resolution.

Tk does not fail when a requested font family is missing: it silently
substitutes its built-in bitmap "fixed" font, which ignores the requested size
and renders at 5 points. The GUI used to hardcode "Helvetica"/"Arial", so on
systems without those families - most notably Linux Tk builds compiled without
Xft, where fontconfig is not available to alias them to an installed font -
every label, entry, tooltip and dialog ended up in that tiny bitmap font.

``ui_font()`` returns a font in the first family from
``SANS_SERIF_CANDIDATES`` that really loads, and logs the substitution instead
of hiding it.
"""

import logging
import tkinter
import tkinter.font as tkfont

from core.constants import MACOS, PLATFORM, WINDOWS

# Families that ship with the platform's own desktop, tried before anything else.
_PLATFORM_FAMILIES = {
    WINDOWS: ("Segoe UI",),
    MACOS: ("Helvetica Neue", "SF Pro Text"),
}.get(PLATFORM, ())

# Ordered preference list for the sans-serif UI font: the platform's own UI
# family first, then the classic names, then the families fontconfig aliases
# those to on Linux, then the X11 core fonts that stay available to Tk builds
# compiled without Xft.
SANS_SERIF_CANDIDATES = _PLATFORM_FAMILIES + (
    "Helvetica",
    "Arial",
    "Liberation Sans",
    "Nimbus Sans",
    "DejaVu Sans",
    "Noto Sans",
    "Cantarell",
    "Roboto",
    "Open Sans",
    "Ubuntu",
    "FreeSans",
)

# Families Tk substitutes when nothing matched; never accept these as a hit.
_SUBSTITUTE_FAMILIES = ("fixed", "cursor")

# Cache of resolved fonts, stored on the Tk root the font is used in so the
# Tcl font stays alive exactly as long as that window does.
_CACHE_ATTR = "_clipcascade_ui_fonts"

_logged_families = set()


def _usable(family, size, weight, slant, underline, overstrike, master):
    """Return a font in *family*, or None when Tk silently substituted one."""
    try:
        candidate = tkfont.Font(
            root=master,
            family=family,
            size=size,
            weight=weight,
            slant=slant,
            underline=underline,
            overstrike=overstrike,
        )
    except tkinter.TclError:
        return None

    actual = candidate.actual()
    resolved = str(actual.get("family", "")).lower()
    if resolved in _SUBSTITUTE_FAMILIES:
        # Tk fell back to its built-in bitmap font.
        return None
    if candidate.metrics("fixed") and resolved != family.lower():
        # A bitmap font stood in for a proportional family.
        return None
    if isinstance(size, int) and int(actual.get("size", size)) != size:
        # The requested size was ignored, so this is not the family asked for.
        return None
    return candidate


def _log_family(family, fallback=False):
    """Log which family the UI ended up with, once per family."""
    if family.lower() in _logged_families:
        return
    _logged_families.add(family.lower())
    if fallback:
        logging.warning(
            "UI font: none of the preferred families are installed (%s); using Tk's "
            "default '%s' instead. Install a scalable sans-serif font, or run with a "
            "Tk that supports Xft, if the UI text looks too small.",
            ", ".join(SANS_SERIF_CANDIDATES),
            family,
        )
    else:
        logging.info("UI font: using family '%s'", family)


def ui_font(
    size,
    weight="normal",
    slant="roman",
    underline=False,
    overstrike=False,
    master=None,
):
    """Return a Tk font in the best sans-serif family available here.

    ``master`` is any widget (or the Tk root) the font will be used in. Pass it
    whenever the window being built is not the default root: Tk fonts belong to
    a single interpreter, and this app keeps one shared root behind several
    separate windows (the login form and the dialogs are Toplevels on it, see
    ``gui/tk_owner.py``).
    """
    if master is None:
        master = tkinter._default_root
        if master is None:
            raise RuntimeError("ui_font() requires a Tk root; pass master=<widget>")

    window = master._root() if hasattr(master, "_root") else master
    cache = window.__dict__.setdefault(_CACHE_ATTR, {})
    key = (size, weight, slant, underline, overstrike)
    cached = cache.get(key)
    if cached is not None:
        return cached

    resolution_args = (size, weight, slant, underline, overstrike, master)
    for family in SANS_SERIF_CANDIDATES:
        font = _usable(family, *resolution_args)
        if font is not None:
            _log_family(str(font.actual().get("family", family)))
            break
    else:
        # Nothing usable is installed: keep Tk's own default family, but at
        # least honour the requested size and style.
        default = tkfont.nametofont("TkDefaultFont", root=master)
        family = str(default.actual().get("family", "TkDefaultFont"))
        _log_family(family, fallback=True)
        font = tkfont.Font(
            root=master,
            family=family,
            size=size,
            weight=weight,
            slant=slant,
            underline=underline,
            overstrike=overstrike,
        )

    cache[key] = font
    return font
