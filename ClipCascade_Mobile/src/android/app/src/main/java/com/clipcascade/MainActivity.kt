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


class MainActivity : ReactActivity() {

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
                sendSharedTextToReactNative(it)
            }
        }

        // text selection popup menu action
        if (Intent.ACTION_PROCESS_TEXT == intent.action && "text/plain" == intent.type) {
            val sharedText = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            sharedText?.let {
                sendSharedTextToReactNative(it.toString())
            }
        }
    }

    private fun sendSharedTextToReactNative(text: String) {
        val reactContext = reactInstanceManager.currentReactContext
        reactContext?.let {
            val params = Arguments.createMap()
            params.putString("text", text)
            it
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("SHARED_TEXT", params)
        }
    }
}
