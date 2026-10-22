package com.clipcascade

import android.app.ActivityManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/** Sticky native supervisor for Notifee's deliberately non-sticky foreground service. */
class RecoveryService : Service() {
    companion object {
        private const val TAG = "ClipCascadeRecovery"
        private const val ACTION_ARM = "com.clipcascade.RECOVERY_ARM"
        private const val ACTION_CHECK = "com.clipcascade.RECOVERY_CHECK"
        private const val CHECK_INTERVAL_MS = 30_000L
        private const val RECOVERY_COOLDOWN_MS = 20_000L

        fun arm(context: Context) = start(context, ACTION_ARM)
        fun requestRecovery(context: Context) = start(context, ACTION_CHECK)
        fun disarm(context: Context) {
            context.stopService(Intent(context, RecoveryService::class.java))
        }

        private fun start(context: Context, action: String) {
            try {
                context.startService(Intent(context, RecoveryService::class.java).setAction(action))
            } catch (e: Exception) {
                Log.e(TAG, "Unable to start recovery supervisor", e)
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var lastRecoveryAt = 0L
    private val periodicCheck = object : Runnable {
        override fun run() {
            checkAndRecover()
            if (shouldRemainArmed()) handler.postDelayed(this, CHECK_INTERVAL_MS) else stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Explicit arming is immediately followed by the normal foreground-service start.
        // Delay the first poll to avoid racing a duplicate headless start.
        handler.postDelayed(periodicCheck, CHECK_INTERVAL_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!shouldRemainArmed()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // A null intent means Android recreated this service after killing the process.
        if (intent == null || intent.action == ACTION_CHECK) checkAndRecover()
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun shouldRemainArmed(): Boolean =
        AsyncStorageBridge(applicationContext).getValue("wsIsRunning") == "true"

    private fun checkAndRecover() {
        if (!shouldRemainArmed() || foregroundServiceIsActive()) return
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return
        lastRecoveryAt = now

        try {
            Log.i(TAG, "Foreground service missing; starting headless recovery")
            startService(Intent(this, HeadlessTaskService::class.java).apply {
                putExtra("event", "SERVICE_RECOVERY")
            })
        } catch (e: Exception) {
            Log.e(TAG, "Unable to launch headless recovery", e)
        }
    }

    @Suppress("DEPRECATION")
    private fun foregroundServiceIsActive(): Boolean = try {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        manager.getRunningServices(Int.MAX_VALUE).any { service ->
            service.service.packageName == packageName &&
                service.service.className == "app.notifee.core.ForegroundService" &&
                service.foreground
        }
    } catch (e: Exception) {
        Log.w(TAG, "Unable to inspect foreground-service state", e)
        false
    }
}
