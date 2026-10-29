// android\app\src\main\java\com\clipcascade\MainActivity.kt
package com.clipcascade

import android.content.Intent
import android.content.Context
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactInstanceManager
import com.facebook.react.devsupport.interfaces.DevSupportManager
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import androidx.work.WorkManager
import androidx.work.PeriodicWorkRequestBuilder
import java.util.concurrent.TimeUnit
import androidx.work.ExistingPeriodicWorkPolicy
import android.util.Log


class MainActivity : ReactActivity() {
    companion object {
        const val TAG = "ClipCascade"
        const val WORK_NAME = "schedule_work"

        fun scheduleJob(context: Context) {
            val request = PeriodicWorkRequestBuilder<ScheduleService>(15, TimeUnit.MINUTES)
                .addTag(WORK_NAME)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request
            )
        }
    }

    /**
    * Returns the name of the main component registered from JavaScript. This is used to schedule
    * rendering of the component.
    */
    override fun getMainComponentName(): String = "ClipCascade"

    /**
    * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
    * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
    */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) intent?.let { handleIntent(it) }

        try{
            val bridgeData = AsyncStorageBridge(applicationContext)
            val enablePeriodicChecks = bridgeData.getValue("enable_periodic_checks")?.toBoolean() ?: true
            if(enablePeriodicChecks) { 
                scheduleJob(applicationContext)
                if(ScheduleService.hasNotificationPermission(applicationContext) == true) {
                    ScheduleService.removeNotificationIfPresent(applicationContext)
                }
            } else {
                WorkManager.getInstance(applicationContext).cancelAllWorkByTag(WORK_NAME)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error scheduling job", e)
        }
    }

    override fun onPause() {
        super.onPause()
        val rm: ReactInstanceManager = reactNativeHost.reactInstanceManager
        val dsm: DevSupportManager = rm.devSupportManager
        if (dsm.devSupportEnabled) {
          dsm.hideRedboxDialog()
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent?.let { handleIntent(it) }
    }

    private fun handleIntent(intent: Intent) {
        ClipboardContent.fromIntent(intent, contentResolver)?.let { content ->
            PendingShares.add(content)
            try {
                reactInstanceManager.currentReactContext
                    ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    ?.emit("SHARE_AVAILABLE", null)
            } catch (e: Exception) {
                // The startup slot remains available if React is not ready yet.
                Log.d(TAG, "Share buffered until JavaScript initializes", e)
            }
        }

        // custom notification action
        if ("com.clipcascade.NOTIFICATION_ACTION" == intent.action) {
            val action = intent.getStringExtra("action")
            if (action == "foreground_service_stopped_running") {
                try {
                    AsyncStorageBridge(applicationContext)
                        .setValue("foreground_service_stopped_running", "true")
                } catch (e: Exception) {
                    Log.e(TAG, "Error connecting/initializing values to AsyncStorageBridge", e)
                }
            }
        }
    }

}
