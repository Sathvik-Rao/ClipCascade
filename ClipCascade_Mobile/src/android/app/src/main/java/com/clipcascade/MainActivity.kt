// android\app\src\main\java\com\clipcascade\MainActivity.kt
package com.clipcascade

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.ReactInstanceManager
import com.facebook.react.devsupport.interfaces.DevSupportManager
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
import android.net.Uri


class MainActivity : ReactActivity() {
    companion object {
        const val TAG = "ClipCascade"
        const val WORK_NAME = "schedule_work"
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

        try{
            val bridgeData = AsyncStorageBridge(applicationContext)
            val enablePeriodicChecks = bridgeData.getValue("enable_periodic_checks")?.toBoolean() ?: true
            if(enablePeriodicChecks) { 
                scheduleJob()
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

    private fun scheduleJob() {
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
        // Handle single shared text
        if (Intent.ACTION_SEND == intent.action && "text/plain" == intent.type) {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
            sharedText?.let {
                sendToReactNative("SHARED_TEXT", "text", it)
            }
        }

        // Handle text via text-selection popup (PROCESS_TEXT)
        else if (Intent.ACTION_PROCESS_TEXT == intent.action && "text/plain" == intent.type) {
            val sharedText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            sharedText?.let {
                sendToReactNative("SHARED_TEXT", "text", it.toString())
            }
        }

        // Handle single image
        else if (Intent.ACTION_SEND == intent.action && intent.type?.startsWith("image/") == true) {
            val imageUri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            imageUri?.let {
                sendToReactNative("SHARED_IMAGE", "image", it.toString())
            }
        }
        
        // Handle single file (any type)
        else if (Intent.ACTION_SEND == intent.action && intent.type != null) {
            val fileUri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            fileUri?.let {
                sendToReactNative("SHARED_FILES", "files", it.toString())
            }
        }

        // Handle multiple files (any type)
        else if (Intent.ACTION_SEND_MULTIPLE == intent.action && intent.type != null) {
            val fileUris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            fileUris?.let {
                val uriList = it.map(Uri::toString).joinToString(",")
                sendToReactNative("SHARED_FILES", "files", uriList)
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
