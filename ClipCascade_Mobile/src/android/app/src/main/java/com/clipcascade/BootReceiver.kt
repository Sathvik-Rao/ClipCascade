// android\app\src\main\java\com\clipcascade\BootReceiver.kt
package com.clipcascade

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> startHeadlessTask(context)
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // Package updates terminate the previous foreground service and
                // its native recovery supervisor. Re-arm the persisted desired
                // state without requiring the user to open the app again.
                RecoveryService.requestRecovery(context)
            }
        }
    }

    private fun startHeadlessTask(context: Context) {
        val headlessTaskIntent = Intent(context, HeadlessTaskService::class.java).apply {
            putExtra("event", "BOOT_COMPLETED")
        }
        context.startService(headlessTaskIntent)
    }
}
