package com.clipcascade

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import androidx.work.WorkManager
import androidx.work.PeriodicWorkRequestBuilder
import java.util.concurrent.TimeUnit
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import android.util.Log


class MainActivity : ReactActivity() {
    companion object {
        const val TAG = "ClipCascade"
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
        intent?.let { handleIntent(it) }
        scheduleJob()
        if(ScheduleService.hasNotificationPermission(applicationContext) == true) {
            ScheduleService.removeNotificationIfPresent(applicationContext)
        }
    }

    private fun scheduleJob() {
        val WORK_NAME = "schedule_work"

        // Check if the work is already scheduled
        val workInfos = WorkManager.getInstance(applicationContext).getWorkInfosByTag(WORK_NAME).get()
        if (workInfos.isEmpty() || 
            (workInfos[0].state != androidx.work.WorkInfo.State.RUNNING && 
            workInfos[0].state != androidx.work.WorkInfo.State.ENQUEUED)) {
            // Periodic work request to run every 15 minutes
            val periodicWorkRequest: PeriodicWorkRequest = PeriodicWorkRequestBuilder<ScheduleService>(15, TimeUnit.MINUTES)
                .addTag(WORK_NAME)
                .build()

            WorkManager.getInstance(applicationContext)
                .enqueueUniquePeriodicWork(
                    WORK_NAME, 
                    ExistingPeriodicWorkPolicy.REPLACE, 
                    periodicWorkRequest
                )
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent?.let { handleIntent(it) }
    }

    private fun handleIntent(intent: Intent) {
        // shared text to app action
        if (Intent.ACTION_SEND == intent.action && "text/plain" == intent.type) {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
            sharedText?.let {
                sendToReactNative("SHARED_TEXT", "text", it)
            }
        }

        // text selection popup menu action
        if (Intent.ACTION_PROCESS_TEXT == intent.action && "text/plain" == intent.type) {
            val sharedText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            sharedText?.let {
                sendToReactNative("SHARED_TEXT", "text", it.toString())
            }
        }

        // custom notification action
        if ("com.clipcascade.NOTIFICATION_ACTION" == intent.action) {
            val action = intent.getStringExtra("action")
            if (action == "foreground_service_stopped_running") {
                var bridgeData : AsyncStorageBridge? = null
                try {
                    bridgeData = AsyncStorageBridge(applicationContext)
                    bridgeData.setValue("foreground_service_stopped_running", "true");
                } catch (e: Exception) {
                    Log.e(TAG, "Error connecting/initializing values to AsyncStorageBridge", e)
                } finally {
                    bridgeData?.disconnect()
                } 
            }
        }
    }

    // Send data to React Native
    private fun sendToReactNative(eventName: String, key: String, value: String) {
        val reactContext = reactInstanceManager.currentReactContext
        reactContext?.let {
            val params = Arguments.createMap().apply { putString(key, value) }
            it
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }
}
