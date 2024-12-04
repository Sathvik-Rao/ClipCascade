package com.clipcascade

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED) {
            startHeadlessTask(context)
        }
    }

    private fun startHeadlessTask(context: Context) {
        val headlessTaskIntent = Intent(context, HeadlessTaskService::class.java).apply {
            putExtra("event", "BOOT_COMPLETED")
        }
        context.startService(headlessTaskIntent)
    }
}
