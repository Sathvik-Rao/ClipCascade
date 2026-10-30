"""Keep GTK/AppIndicator menus live while they are open."""

from gi.repository import GLib, Gtk
from pystray import Icon, Menu
from pystray._util.gtk import mainloop


class LinuxTrayIcon(Icon):
    @mainloop
    def _update_menu(self):
        if getattr(self, '_menu_handle', None) is None:
            # The backend also attaches the initial menu to AppIndicator.
            super()._update_menu()
            return
        self._sync_menu(self._menu_handle, self.menu)

    def _create_menu_item(self, entry):
        if entry is Menu.SEPARATOR:
            return Gtk.SeparatorMenuItem()
        if entry.checked is not None:
            current = Gtk.CheckMenuItem.new_with_label(entry.text)
            current.set_active(entry.checked)
            current.set_draw_as_radio(entry.radio)
        else:
            current = Gtk.MenuItem.new_with_label(entry.text)
        if entry.submenu:
            current.set_submenu(self._create_menu(entry.submenu))
        else:
            current._clipcascade_activate = current.connect('activate', self._handler(entry))
        if entry.default:
            current.get_children()[0].set_markup(
                '<b>%s</b>' % GLib.markup_escape_text(entry.text)
            )
        current.set_sensitive(entry.enabled)
        return current

    def _sync_menu(self, native_menu, menu):
        entries = list(menu or ())
        children = native_menu.get_children()
        for position, entry in enumerate(entries):
            if position >= len(children):
                native_menu.append(self._create_menu_item(entry))
                continue
            current = children[position]
            # Menu descriptors are immutable, but their callbacks can change
            # (for example, a newly received file). Rebind the activation too.
            if entry is Menu.SEPARATOR and isinstance(current, Gtk.SeparatorMenuItem):
                continue
            if (entry is Menu.SEPARATOR or isinstance(current, Gtk.SeparatorMenuItem)
                    or bool(current.get_submenu()) != bool(entry.submenu)
                    or isinstance(current, Gtk.CheckMenuItem) != (entry.checked is not None)):
                native_menu.remove(current)
                native_menu.insert(self._create_menu_item(entry), position)
                continue
            current.set_label(entry.text)
            current.set_sensitive(entry.enabled)
            if entry.checked is not None:
                current.set_active(entry.checked)
                current.set_draw_as_radio(entry.radio)
            if entry.default:
                current.get_children()[0].set_markup(
                    '<b>%s</b>' % GLib.markup_escape_text(entry.text)
                )
            if entry.submenu:
                self._sync_menu(current.get_submenu(), entry.submenu)
            else:
                current.disconnect(current._clipcascade_activate)
                current._clipcascade_activate = current.connect('activate', self._handler(entry))
        for current in children[len(entries):]:
            native_menu.remove(current)
        native_menu.show_all()
