// android\app\src\main\java\com\clipcascade\ScheduleService.kt
package com.clipcascade

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.WorkerParameters
import android.app.Notification
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
        private var activityVisible = false
        private var notificationGeneration = 0L

        @Synchronized
        fun onActivityStarted(context: Context) {
            activityVisible = true
            removeNotificationIfPresent(context)
        }

        @Synchronized
        fun onActivityStopped() {
            activityVisible = false
        }

        @Synchronized
        fun removeNotificationIfPresent(context: Context) {
            // A check that began before this dismissal can no longer post an alert.
            notificationGeneration++
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(NOTIFICATION_ID)
        }

        @Synchronized
        private fun beginNotificationCheck(): Long? =
            if (activityVisible) null else notificationGeneration

        @Synchronized
        private fun postNotification(
            generation: Long,
            notificationManager: NotificationManager,
            notification: Notification
        ) {
            if (!activityVisible && generation == notificationGeneration) {
                notificationManager.notify(NOTIFICATION_ID, notification)
            }
        }

        private fun hasNotificationPermission(context: Context): Boolean {
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
        val generation = beginNotificationCheck() ?: return Result.success()

        // show notification if foreground service is not running
        try {
            if(hasNotificationPermission(applicationContext)) {
                val bridgeData = AsyncStorageBridge(applicationContext)
                if(enableForegroundService(bridgeData)) {
                    if(!foregroundServiceIsActive(bridgeData) && enableForegroundService(bridgeData)) {
                        showNotificationIfNotPresent(generation)
                    } else {
                        removeNotificationIfPresent(applicationContext)
                    }
                } else {
                    removeNotificationIfPresent(applicationContext)
                }
            }

            return Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Error running worker", e)
            return Result.failure()
        }
    }


    fun enableForegroundService(bridgeData: AsyncStorageBridge) : Boolean {
        // Monitor requested sync even after a handled service failure.
        return bridgeData.isSyncRequested()
    } 
    
    suspend fun foregroundServiceIsActive(bridgeData: AsyncStorageBridge) : Boolean {
        // check if foreground service is running
        bridgeData.setValue("echo", "ping")
        repeat(35) { // 3500 ms
            delay(100) // Wait for 100 ms
            if (bridgeData.getValue("echo") == "pong") {
                return true
            }
        }
        return false
    }

    private fun showNotificationIfNotPresent(generation: Long) {
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

            postNotification(generation, notificationManager, notification)
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
