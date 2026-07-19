// android\app\src/main/java/com/clipcascade/ClipboardListenerModule.kt
package com.clipcascade

import android.content.ClipboardManager
import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Explicit clipboard capture only.
 *
 * READ_LOGS + overlay floating activity are intentionally removed.
 * Use share intents, Quick Settings tile, or the "Share clipboard now"
 * notification action instead of invasive logcat monitoring.
 */
class ClipboardListenerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var clipboardManager: ClipboardManager =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private var isListening = false
    private var lastEmittedTime: Long = 0
    private val debounceTime: Long = 250

    override fun getName(): String {
        return "ClipboardListener"
    }

    @ReactMethod
    fun startListening() {
        if (isListening) {
            return
        }

        listener = ClipboardManager.OnPrimaryClipChangedListener {
            emitCurrentClipboard()
        }
        clipboardManager.addPrimaryClipChangedListener(listener)
        isListening = true
    }

    @ReactMethod
    fun stopListening() {
        listener?.let {
            clipboardManager.removePrimaryClipChangedListener(it)
            listener = null
            isListening = false
        }
    }

    /**
     * Explicit one-shot capture (tile / notification action / UI button).
     */
    @ReactMethod
    fun captureNow() {
        emitCurrentClipboard(force = true)
    }

    private fun emitCurrentClipboard(force: Boolean = false) {
        val clip = clipboardManager.primaryClip
        if (clip == null || clip.itemCount <= 0) {
            return
        }

        val description = clip.description ?: return
        val mimeType = description.getMimeType(0) ?: return
        val item = clip.getItemAt(0)
        val params: WritableMap = Arguments.createMap()

        when {
            mimeType.startsWith("text/") && item.text != null -> {
                params.putString("content", item.text.toString())
                params.putString("type", "text")
            }
            mimeType.startsWith("image/") && item.uri != null -> {
                params.putString("content", item.uri.toString())
                params.putString("type", "image")
            }
            item.uri != null -> {
                params.putString("content", item.uri.toString())
                params.putString("type", "files")
            }
            else -> return
        }

        val currentTime = System.currentTimeMillis()
        if (!force && currentTime - lastEmittedTime <= debounceTime) {
            return
        }
        lastEmittedTime = currentTime
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onClipboardChange", params)
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
