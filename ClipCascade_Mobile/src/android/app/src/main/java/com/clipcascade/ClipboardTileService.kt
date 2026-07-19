package com.clipcascade

import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.annotation.RequiresApi

/**
 * Quick Settings tile: explicit "Share clipboard now" without READ_LOGS/overlay.
 */
@RequiresApi(Build.VERSION_CODES.N)
class ClipboardTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            label = "ClipCascade"
            contentDescription = "Share clipboard now"
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        val intent = Intent(this, MainActivity::class.java).apply {
            action = ACTION_CAPTURE_CLIPBOARD
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        // MainActivity ignores this action unless it can prove we sent it.
        InternalIntents.stamp(applicationContext, intent)
        startActivityAndCollapse(intent)
    }

    companion object {
        const val ACTION_CAPTURE_CLIPBOARD = "com.clipcascade.ACTION_CAPTURE_CLIPBOARD"
    }
}
