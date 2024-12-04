package com.clipcascade

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
        var bridgeData : AsyncStorageBridge? = null
        try {
            if(hasNotificationPermission(applicationContext)) {
                bridgeData = AsyncStorageBridge(applicationContext)
                if(enableForegroundService(bridgeData)) {
                    if(!foregroundServiceIsActive(bridgeData)) {
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
        } finally {
            bridgeData?.disconnect()
        }
    }


    fun enableForegroundService(bridgeData: AsyncStorageBridge) : Boolean {
        // Get websocket(foreground service) status (enabled/disabled)
        return bridgeData.getValue("wsIsRunning")?.toBoolean() ?: false 
    } 
    
    suspend fun foregroundServiceIsActive(bridgeData: AsyncStorageBridge) : Boolean {
        // check if foreground service is running
        bridgeData.setValue("echo", "ping");
        repeat(35) { // 3500 ms
            delay(100) // Wait for 100 ms
            if (bridgeData.getValue("echo") == "pong") {
                return true
            }
        }
        return false
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