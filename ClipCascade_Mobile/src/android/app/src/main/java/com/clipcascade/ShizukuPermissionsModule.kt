package com.clipcascade

import android.Manifest
import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import rikka.shizuku.Shizuku
import java.util.concurrent.Executors

class ShizukuPermissionsModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    // All request state is confined to the main thread.
    private var pending: Promise? = null
    private var forceStop = false
    private var connection: ServiceConnection? = null
    private val args = Shizuku.UserServiceArgs(
        ComponentName(context.packageName, PermissionGrantService::class.java.name)
    ).daemon(false).processNameSuffix("permission_grant").version(2)
    private val timeout = Runnable {
        finish("SHIZUKU_TIMEOUT", "Shizuku setup timed out. Check Shizuku and try again.")
    }
    private val permissionListener = Shizuku.OnRequestPermissionResultListener { code, result ->
        main.post {
            if (code == REQUEST_CODE && pending != null) {
                if (result == PackageManager.PERMISSION_GRANTED) bindService()
                else finish("SHIZUKU_DENIED", "Access denied. Allow ClipCascade in Shizuku, then try again.")
            }
        }
    }
    private val deadListener = Shizuku.OnBinderDeadListener {
        main.post { finish("SHIZUKU_STOPPED", "Shizuku stopped. Start it and try again.") }
    }

    override fun getName() = "ShizukuPermissions"

    @ReactMethod
    fun grantPermissions(promise: Promise) = startRequest(promise, false)

    @ReactMethod
    fun forceStopApp(promise: Promise) = startRequest(promise, true)

    private fun startRequest(promise: Promise, stopApp: Boolean) {
        main.post {
            if (pending != null) {
                promise.reject("SHIZUKU_BUSY", "Permission setup is already in progress.")
                return@post
            }
            pending = promise
            forceStop = stopApp
            try {
                if (!Shizuku.pingBinder()) {
                    finish("SHIZUKU_UNAVAILABLE", "Install and start Shizuku, then try again.")
                } else if (Shizuku.isPreV11()) {
                    finish("SHIZUKU_OLD", "Update Shizuku before granting permissions.")
                } else {
                    Shizuku.addRequestPermissionResultListener(permissionListener)
                    Shizuku.addBinderDeadListener(deadListener)
                    main.postDelayed(timeout, 90_000)
                    if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                        bindService()
                    } else if (Shizuku.shouldShowRequestPermissionRationale()) {
                        finish("SHIZUKU_DENIED", "Allow ClipCascade in Shizuku's authorized applications, then try again.")
                    } else {
                        Shizuku.requestPermission(REQUEST_CODE)
                    }
                }
            } catch (e: Exception) {
                finish("SHIZUKU_ERROR", e.message ?: "Unable to connect to Shizuku.")
            }
        }
    }

    private fun bindService() {
        if (connection != null || pending == null) return
        val request = pending
        val stopApp = forceStop
        val newConnection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                main.post {
                    if (connection !== this || pending !== request) return@post
                    worker.execute {
                        val error = try {
                            val service = IPermissionGrantService.Stub.asInterface(binder)
                                ?: error("Shizuku permission service is unavailable.")
                            val userId = Process.myUid() / 100000
                            if (stopApp) service.forceStopApp(userId)
                            else service.grantPermissions(userId)
                        } catch (e: Exception) {
                            e.message ?: "Permission setup failed."
                        }
                        main.post {
                            if (connection === this && pending === request) {
                                // A successful force-stop kills the calling app. If it is
                                // still alive, report the failure instead of claiming closure.
                                if (stopApp) {
                                    finish("SHIZUKU_STOP_FAILED", error.ifBlank {
                                        "Android did not close ClipCascade. Force stop it from Android App info."
                                    })
                                    return@post
                                }
                                val result = Arguments.createMap().apply {
                                    putBoolean("readLogs", ContextCompat.checkSelfPermission(
                                        context, Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED)
                                    putBoolean("overlay", Settings.canDrawOverlays(context))
                                    putString("error", error)
                                }
                                val promise = pending
                                cleanup()
                                pending = null
                                promise?.resolve(result)
                            }
                        }
                    }
                }
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                main.post {
                    if (connection === this) finish("SHIZUKU_DISCONNECTED", "Shizuku disconnected. Try again.")
                }
            }
        }
        connection = newConnection
        try {
            Shizuku.bindUserService(args, newConnection)
        } catch (e: Exception) {
            finish("SHIZUKU_BIND_FAILED", e.message ?: "Unable to start Shizuku permission service.")
        }
    }

    private fun cleanup() {
        main.removeCallbacks(timeout)
        Shizuku.removeRequestPermissionResultListener(permissionListener)
        Shizuku.removeBinderDeadListener(deadListener)
        connection?.let {
            try { Shizuku.unbindUserService(args, it, true) } catch (_: Exception) { }
        }
        connection = null
    }

    private fun finish(code: String, message: String) {
        val promise = pending ?: return
        pending = null
        cleanup()
        promise.reject(code, message)
    }

    override fun invalidate() {
        main.post {
            finish("SHIZUKU_CANCELLED", "Permission setup was cancelled.")
            worker.shutdownNow()
        }
        super.invalidate()
    }

    companion object { private const val REQUEST_CODE = 17901 }
}
