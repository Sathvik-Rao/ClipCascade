// android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
package com.clipcascade

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.InputStreamReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale


class ClipboardListenerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var clipboardManager: ClipboardManager =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private var isListening = false
    private var lastEmittedTime: Long = 0 // for clipboard listener debounce
    private var lastActivityStartTime: Long = 0 // for log cat monitoring  debounce
    private val debounceTime: Long = 0 // milliseconds (increase to debounce clipboard listener)
    private val activityDebounceTime: Long = 1000 // milliseconds (increase to debounce log cat monitoring)

    // Each reader owns its cancellation and process. A previous thread must
    // never destroy the process created by a later monitoring session.
    private class LogcatReader {
        @Volatile var stopped = false
        @Volatile var process: Process? = null
        var thread: Thread? = null
    }
    private var logcatReader: LogcatReader? = null
    

    override fun getName(): String {
        return "ClipboardListener"
    }

    @ReactMethod
    fun startListening() {
        if (isListening) {
            return
        }

        // 1) Clipboard listener
        listener = ClipboardManager.OnPrimaryClipChangedListener {
            try {
                clipboardManager.primaryClip?.let { clip ->
                    ClipboardContent.fromClipboard(clip, reactApplicationContext.contentResolver)
                        ?.let {
                            PendingShares.clear()
                            sendEventToJS(it.toMap())
                        }
                }
            } catch (e: Exception) {
                android.util.Log.e("ClipCascade", "Failed to read clipboard", e)
            }
        }
        clipboardManager.addPrimaryClipChangedListener(listener)
        isListening = true

        // 2) Logcat monitoring
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P &&
            ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED
        ) {
            val session = LogcatReader()
            logcatReader = session
            session.thread = Thread {
                try {
                    val timeStamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())
                        .format(Date())
                    val process = Runtime.getRuntime().exec(
                        arrayOf("logcat", "-T", timeStamp, "ClipboardService:E", "*:S")
                    )
                    session.process = process
                    if (session.stopped) return@Thread
                    val reader = BufferedReader(InputStreamReader(process.inputStream))
                    var line: String? = null
                    reader.use { br ->
                        while (!session.stopped && br.readLine().also { line = it } != null) {
                            if (session.stopped) break
                            if (line!!.contains(BuildConfig.APPLICATION_ID)) {
                                val currentTime = System.currentTimeMillis()
                                if (currentTime - lastActivityStartTime > activityDebounceTime) {
                                    lastActivityStartTime = currentTime
                                    // launch the floating activity
                                    reactApplicationContext.startActivity(
                                        ClipboardFloatingActivity.getIntent(reactApplicationContext)
                                    )
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                } finally {
                    try {
                        session.process?.destroy()
                    } catch (_: Exception) {}
                }
            }.apply {
                isDaemon = true
                start()
            }
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

        // 2) Tear down logcat‐reader thread & process
        val session = logcatReader
        logcatReader = null
        session?.stopped = true
        try {
            session?.thread?.interrupt()
        } catch (_: Exception) {}
        try {
            session?.process?.destroy()
        } catch (_: Exception) {}
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

