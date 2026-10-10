// android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
package com.clipcascade

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule


class ClipboardListenerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var clipboardManager: ClipboardManager =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private var isListening = false
    private var lastEmittedTime: Long = 0 // for clipboard listener debounce
    private val debounceTime: Long = 0 // milliseconds (increase to debounce clipboard listener)
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val heartbeatIntervalMs = 5_000L
    private var lastClipboardServiceHealthy = true
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (!isListening) return
            try {
                if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) {
                    val healthy = shizukuClipboard.ensureListening()
                    if (healthy != lastClipboardServiceHealthy) {
                        if (healthy) {
                            android.util.Log.i("ClipCascade.Clipboard", "Shizuku clipboard callback recovered")
                        } else {
                            android.util.Log.w("ClipCascade.Clipboard", "Shizuku clipboard callback unavailable; recovering")
                        }
                    }
                    lastClipboardServiceHealthy = healthy
                }
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onClipboardWatchdog", Arguments.createMap())
            } catch (e: Exception) {
                android.util.Log.w("ClipCascade.Clipboard", "Clipboard watchdog failed; retrying", e)
            } finally {
                if (isListening) heartbeatHandler.postDelayed(this, heartbeatIntervalMs)
            }
        }
    }
    private val shizukuClipboard = ShizukuClipboardManager(reactContext) { params ->
        sendEventToJS(params)
    }
    

    override fun getName(): String {
        return "ClipboardListener"
    }

    @ReactMethod
    fun startListening() {
        if (isListening) {
            if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) {
                shizukuClipboard.ensureListening()
            }
            return
        }

        // 1) Clipboard listener
        listener = ClipboardManager.OnPrimaryClipChangedListener {
            val clip = clipboardManager.primaryClip
            if (clip != null && clip.itemCount > 0) {

                val description = clip.description
                if (description != null) { 

                    val mimeType = description.getMimeType(0)
                    if (mimeType != null) {
                        
                        val item = clip.getItemAt(0)
                        val params: WritableMap = Arguments.createMap()
                        
                        if (mimeType.startsWith("text/") && item.text != null) {
                            // Text
                            params.putString("content", item.text.toString())
                            params.putString("type", "text")
                        }
                        else if (mimeType.startsWith("image/") && item.uri != null) {
                            // Image
                            params.putString("content", item.uri.toString())
                            params.putString("type", "image")
                        }
                        else if (item.uri != null) {
                            // Files
                            params.putString("content", item.uri.toString())
                            params.putString("type", "files")
                        }

                        sendEventToJS(params)
                    }
                }
            }
        }
        clipboardManager.addPrimaryClipChangedListener(listener)
        isListening = true
        heartbeatHandler.removeCallbacks(heartbeatRunnable)
        heartbeatHandler.postDelayed(heartbeatRunnable, heartbeatIntervalMs)

        // 2) Android 10+ background clipboard access through Shizuku. This avoids
        // READ_LOGS and overlay permissions entirely.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) {
            shizukuClipboard.start()
        }
    }

    @ReactMethod
    fun stopListening() {
        // 1) Remove clipboard listener
        listener?.let {
            clipboardManager.removePrimaryClipChangedListener(it)
            listener = null
            isListening = false
        }

        heartbeatHandler.removeCallbacks(heartbeatRunnable)

        // 2) Stop Shizuku-backed background monitoring
        shizukuClipboard.stop()
    }

    override fun invalidate() {
        stopListening()
        shizukuClipboard.destroy()
        super.invalidate()
    }


    private fun sendEventToJS(params: WritableMap) {
        val currentTime = System.currentTimeMillis()
        if (currentTime - lastEmittedTime > debounceTime) {
            lastEmittedTime = currentTime
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onClipboardChange", params)
        }
    }

    @ReactMethod
    fun addListener(type: String?) {
        // Required for RN built-in Event Emitter Calls.
    }

    @ReactMethod
    fun removeListeners(type: Int?) {
        // Required for RN built-in Event Emitter Calls.
    }
}

