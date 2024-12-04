package com.clipcascade

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.ReactInstanceManager
import com.facebook.react.bridge.ReactContext
import android.view.ViewTreeObserver


/*
 * # Enable the READ_LOGS permission. 
 * adb -d shell pm grant com.clipcascade android.permission.READ_LOGS;
 * # Allow "Drawing over other apps", also accessible from Settings on the phone.
 * adb -d shell appops set com.clipcascade SYSTEM_ALERT_WINDOW allow;
 * # Kill the app, new permissions take effect on restart.
 * adb -d shell am force-stop com.clipcascade;
 */
class ClipboardFloatingActivity : AppCompatActivity() {

    private lateinit var windowManager: WindowManager
    private lateinit var floatingView: View
    private lateinit var clipboardManager: ClipboardManager
    private var reactContext: ReactContext? = null
    private var isViewAttached = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        clipboardManager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        reactContext = getReactContext()

        createFloatingView()
        makeFloatingViewInFocus()

        // Use ViewTreeObserver to listen for layout change
        floatingView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                try {
                    floatingView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    getClipboardContent()
                } catch (e: Exception) {
                    e.printStackTrace()
                } finally {
                    makeFloatingViewOutOfFocus()
                    removeFloatingView()
                }
            }
        })
    }

    private fun createFloatingView() {
        val inflater = getSystemService(Context.LAYOUT_INFLATER_SERVICE) as LayoutInflater
        floatingView = inflater.inflate(R.layout.floating_view_layout, null)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            android.graphics.PixelFormat.TRANSLUCENT
        ).apply {
            x = 0
            y = 0
        }

        windowManager.addView(floatingView, params)
        isViewAttached = true
    }

    private fun getClipboardContent() {
        val clip = clipboardManager.primaryClip
        if (clip != null && clip.itemCount > 0) {
            val clipboardText = clip.getItemAt(0).text.toString()
            // Send event to JS
            reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit("onClipboardChange", clipboardText)
        }
    }

    private fun makeFloatingViewInFocus() {
        if (isViewAttached) {
            val params = floatingView.layoutParams as WindowManager.LayoutParams
            params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
            windowManager.updateViewLayout(floatingView, params)
        }
    }

    private fun makeFloatingViewOutOfFocus() {
        if (isViewAttached) {
            val params = floatingView.layoutParams as WindowManager.LayoutParams
            params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            windowManager.updateViewLayout(floatingView, params)
        }
    }

    private fun getReactContext(): ReactContext? {
        val reactInstanceManager: ReactInstanceManager =
            (applicationContext as MainApplication).reactNativeHost.reactInstanceManager
        return reactInstanceManager.currentReactContext
    }

    private fun removeFloatingView() {
        if (isViewAttached) {
            windowManager.removeView(floatingView)
            isViewAttached = false
        }
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        removeFloatingView()
    }

    companion object {
        fun getIntent(context: Context): Intent {
            return Intent(context.applicationContext, ClipboardFloatingActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            }
        }
    }
}
