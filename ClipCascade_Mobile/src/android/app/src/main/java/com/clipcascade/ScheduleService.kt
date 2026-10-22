// android\app\src\main\java\com\clipcascade\ScheduleService.kt
package com.clipcascade

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.WorkerParameters
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import kotlinx.coroutines.delay
import android.app.PendingIntent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.util.Log


class ScheduleService(context: Context, workerParams: WorkerParameters) : CoroutineWorker(context, workerParams) {
    
    companion object {
        private const val TAG = "ScheduleService"
        private const val NOTIFICATION_CHANNEL_ID = "clipcascade_foreground_service_stopped_running"
        private const val NOTIFICATION_ID = 1

        fun removeNotificationIfPresent(context: Context) {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(NOTIFICATION_ID)
        }

        fun hasNotificationPermission(context: Context): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    context,
                    android.Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        }
    }

    // init
    override suspend fun doWork(): Result {

        // show notification if foreground service is not running
        try {
            if(hasNotificationPermission(applicationContext)) {
                val bridgeData = AsyncStorageBridge(applicationContext)
                if(enableForegroundService(bridgeData)) {
                    if(!foregroundServiceIsActive(bridgeData)) {
                        RecoveryService.requestRecovery(applicationContext)
                        showNotificationIfNotPresent()
                    } else {
                        removeNotificationIfPresent(applicationContext)
                    }
                }
            }

            return Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Error running worker", e)
            return Result.failure()
        }
    }


    fun enableForegroundService(bridgeData: AsyncStorageBridge) : Boolean {
        // Get websocket(foreground service) status (enabled/disabled)
        return bridgeData.getValue("wsIsRunning")?.toBoolean() ?: false 
    } 
    
    suspend fun foregroundServiceIsActive(bridgeData: AsyncStorageBridge) : Boolean {
        // Android already knows whether our foreground service is alive. Prefer
        // that over the JS heartbeat, which can time out while React Native is
        // briefly busy even though clipboard monitoring is still running.
        if (nativeForegroundServiceIsActive()) {
            return true
        }

        // Keep the heartbeat as a compatibility fallback in case a device hides
        // running-service details from ActivityManager.
        bridgeData.setValue("echo", "ping")
        repeat(100) {
            delay(100)
            if (bridgeData.getValue("echo") == "pong") {
                return true
            }
        }
        return false
    }

    private fun nativeForegroundServiceIsActive(): Boolean {
        return try {
            val activityManager = applicationContext
                .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            activityManager.getRunningServices(Int.MAX_VALUE).any { service ->
                service.service.packageName == applicationContext.packageName &&
                    service.service.className == "app.notifee.core.ForegroundService" &&
                    service.foreground
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unable to query native foreground-service state", e)
            false
        }
    }

    private fun showNotificationIfNotPresent() {
        val notificationManager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "ClipCascade Alerts",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            notificationManager.createNotificationChannel(channel)
        }

        // Check if the notification is already shown
        if (!isNotificationActive(notificationManager)) {
            val intent = Intent(applicationContext, MainActivity::class.java).apply {
                action = "com.clipcascade.NOTIFICATION_ACTION"
                putExtra("action", "foreground_service_stopped_running")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }

            val pendingIntent = PendingIntent.getActivity(
                applicationContext, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val notification = NotificationCompat.Builder(applicationContext, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification_failure)
                .setContentTitle("ClipCascade Service Inactive")
                .setContentText("ClipCascade monitoring is inactive. Tap to restart.")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build()

            notificationManager.notify(NOTIFICATION_ID, notification)
        }
    }

    private fun isNotificationActive(notificationManager: NotificationManager): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val activeNotifications = notificationManager.activeNotifications
            return activeNotifications.any { it.id == NOTIFICATION_ID }
        }
        return false
    }
}
