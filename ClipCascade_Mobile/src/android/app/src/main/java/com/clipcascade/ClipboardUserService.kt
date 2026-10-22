package com.clipcascade

import android.content.ClipData
import android.content.ClipDescription
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import java.util.IdentityHashMap

/**
 * Shizuku UserService that runs as the shell UID and talks directly to Android's
 * clipboard Binder service. Adapted from Jeric-X/syncclipboard-mobile (MIT).
 */
class ClipboardUserService : IClipboardUserService.Stub() {
    companion object {
        private const val TAG = "ClipCascade.ShizukuClipboard"
        private const val PACKAGE_NAME = "com.android.shell"
        private const val PRIMARY_CLIP_CHANGED_DESCRIPTOR =
            "android.content.IOnPrimaryClipChangedListener"
        private const val TRANSACTION_DISPATCH_PRIMARY_CLIP_CHANGED =
            IBinder.FIRST_CALL_TRANSACTION

        private var clipboardService: Any? = null
        private var clipboardBinder: IBinder? = null

        init {
            // Shizuku may itself be running as root. ClipboardService verifies that
            // callingPackage belongs to Binder.getCallingUid(), so use shell UID 2000.
            if (android.os.Process.myUid() == 0) {
                try {
                    android.system.Os.setgid(2000)
                    android.system.Os.setuid(2000)
                } catch (e: Exception) {
                    android.util.Log.e(TAG, "Failed to switch UserService to shell UID", e)
                }
            }
        }

        @Synchronized
        private fun getClipboardService(): Any? {
            val cachedBinder = clipboardBinder
            if (clipboardService != null && cachedBinder != null &&
                cachedBinder.isBinderAlive && cachedBinder.pingBinder()
            ) {
                return clipboardService
            }

            clipboardService = null
            clipboardBinder = null
            return try {
                val serviceManager = Class.forName("android.os.ServiceManager")
                val getService = serviceManager.getMethod("getService", String::class.java)
                val binder = getService.invoke(null, "clipboard") as? IBinder ?: return null
                val stub = Class.forName("android.content.IClipboard\$Stub")
                val asInterface = stub.getMethod("asInterface", IBinder::class.java)
                clipboardBinder = binder
                asInterface.invoke(null, binder).also { clipboardService = it }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "Failed to obtain clipboard Binder", e)
                null
            }
        }

        private fun buildArgs(paramTypes: Array<Class<*>>): Array<Any?>? {
            return try {
                paramTypes.map { type ->
                    when {
                        type == String::class.java -> null
                        type == Int::class.javaPrimitiveType || type == Int::class.java -> 0
                        type == Long::class.javaPrimitiveType || type == Long::class.java -> 0L
                        type == Boolean::class.javaPrimitiveType || type == Boolean::class.java -> false
                        else -> return null
                    }
                }.toTypedArray()
            } catch (_: Exception) {
                null
            }
        }

        private fun findAndInvokeMethod(clipboard: Any, methodName: String): Any? {
            val methods = clipboard.javaClass.methods
                .filter { it.name == methodName }
                .sortedByDescending { it.parameterCount }

            for (method in methods) {
                val args = buildArgs(method.parameterTypes) ?: continue
                for (i in method.parameterTypes.indices) {
                    if (method.parameterTypes[i] == String::class.java) {
                        args[i] = PACKAGE_NAME
                        break
                    }
                }
                try {
                    return method.invoke(clipboard, *args)
                } catch (e: Exception) {
                    android.util.Log.d(
                        TAG,
                        "$methodName/${method.parameterCount} rejected: ${e.cause ?: e}"
                    )
                }
            }
            return null
        }
    }

    private data class ClientRecord(
        val token: IBinder,
        val deathRecipient: IBinder.DeathRecipient,
        var callback: IClipboardChangedCallback
    )

    private val clients = IdentityHashMap<IBinder, ClientRecord>()
    private val clientLock = Any()
    private var systemListener: Any? = null
    private var registeredClipboardBinder: IBinder? = null

    private val systemListenerBinder = object : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            when (code) {
                INTERFACE_TRANSACTION -> {
                    reply?.writeString(PRIMARY_CLIP_CHANGED_DESCRIPTOR)
                    return true
                }
                TRANSACTION_DISPATCH_PRIMARY_CLIP_CHANGED -> {
                    data.enforceInterface(PRIMARY_CLIP_CHANGED_DESCRIPTOR)
                    val callbacks = synchronized(clientLock) {
                        clients.values.map { it.token to it.callback }
                    }
                    callbacks.forEach { (token, callback) ->
                        try {
                            callback.onPrimaryClipChanged()
                        } catch (_: Exception) {
                            removeFailedClient(token, callback)
                        }
                    }
                    return true
                }
            }
            return super.onTransact(code, data, reply, flags)
        }
    }

    override fun getPrimaryClipText(): String {
        return try {
            val clipboard = getClipboardService() ?: return ""
            val clip = findAndInvokeMethod(clipboard, "getPrimaryClip") as? ClipData
            if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).text?.toString() ?: ""
            } else {
                ""
            }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "getPrimaryClipText failed", e)
            ""
        }
    }

    override fun getPrimaryClipMimeType(): String {
        return try {
            val clipboard = getClipboardService() ?: return ""
            val description =
                findAndInvokeMethod(clipboard, "getPrimaryClipDescription") as? ClipDescription
            if (description != null && description.mimeTypeCount > 0) {
                description.getMimeType(0) ?: ""
            } else {
                ""
            }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "getPrimaryClipMimeType failed", e)
            ""
        }
    }

    override fun getPrimaryClipUri(): String {
        return try {
            val clipboard = getClipboardService() ?: return ""
            val clip = findAndInvokeMethod(clipboard, "getPrimaryClip") as? ClipData
            if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).uri?.toString() ?: ""
            } else {
                ""
            }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "getPrimaryClipUri failed", e)
            ""
        }
    }

    override fun setClipboardChangedCallback(
        callerToken: IBinder,
        callback: IClipboardChangedCallback
    ): Boolean {
        synchronized(clientLock) {
            val client = clients[callerToken] ?: run {
                val deathRecipient = IBinder.DeathRecipient {
                    synchronized(clientLock) {
                        clients.remove(callerToken)
                        if (clients.isEmpty()) unregisterSystemListenerLocked()
                    }
                }
                try {
                    callerToken.linkToDeath(deathRecipient, 0)
                } catch (_: Exception) {
                    return false
                }
                ClientRecord(callerToken, deathRecipient, callback).also {
                    clients[callerToken] = it
                }
            }
            client.callback = callback

            val clipboard = getClipboardService() ?: return false
            val binder = clipboardBinder ?: return false
            if (registeredClipboardBinder === binder) return true

            unregisterSystemListenerLocked()
            val listener = getOrCreateSystemListener() ?: return false
            val registered = invokeListenerRegistration(
                clipboard,
                "addPrimaryClipChangedListener",
                listener
            )
            registeredClipboardBinder = if (registered) binder else null
            return registered
        }
    }

    override fun clearClipboardChangedCallback(callerToken: IBinder) {
        synchronized(clientLock) {
            val client = clients.remove(callerToken) ?: return
            try {
                callerToken.unlinkToDeath(client.deathRecipient, 0)
            } catch (_: Exception) {
            }
            if (clients.isEmpty()) unregisterSystemListenerLocked()
        }
    }

    private fun removeFailedClient(token: IBinder, callback: IClipboardChangedCallback) {
        synchronized(clientLock) {
            val client = clients[token] ?: return
            if (client.callback.asBinder() !== callback.asBinder()) return
            clients.remove(token)
            try {
                token.unlinkToDeath(client.deathRecipient, 0)
            } catch (_: Exception) {
            }
            if (clients.isEmpty()) unregisterSystemListenerLocked()
        }
    }

    private fun getOrCreateSystemListener(): Any? {
        if (systemListener != null) return systemListener
        return try {
            val stub = Class.forName("android.content.IOnPrimaryClipChangedListener\$Stub")
            val asInterface = stub.getMethod("asInterface", IBinder::class.java)
            asInterface.invoke(null, systemListenerBinder).also { systemListener = it }
        } catch (e: Exception) {
            android.util.Log.e(TAG, "Failed to create clipboard listener Binder", e)
            null
        }
    }

    private fun unregisterSystemListenerLocked() {
        if (registeredClipboardBinder == null) return
        try {
            val clipboard = getClipboardService()
            val listener = systemListener
            if (clipboard != null && listener != null) {
                invokeListenerRegistration(
                    clipboard,
                    "removePrimaryClipChangedListener",
                    listener
                )
            }
        } catch (_: Exception) {
        } finally {
            registeredClipboardBinder = null
        }
    }

    private fun invokeListenerRegistration(
        clipboard: Any,
        methodName: String,
        listener: Any
    ): Boolean {
        val methods = clipboard.javaClass.methods
            .filter { it.name == methodName }
            .sortedByDescending { it.parameterCount }

        for (method in methods) {
            val args = buildListenerArgs(method.parameterTypes, listener) ?: continue
            try {
                method.invoke(clipboard, *args)
                return true
            } catch (e: Exception) {
                android.util.Log.d(
                    TAG,
                    "$methodName/${method.parameterCount} rejected: ${e.cause ?: e}"
                )
            }
        }
        return false
    }

    private fun buildListenerArgs(
        paramTypes: Array<Class<*>>,
        listener: Any
    ): Array<Any?>? {
        var listenerAssigned = false
        var stringIndex = 0
        return paramTypes.map { type ->
            when {
                type.name == PRIMARY_CLIP_CHANGED_DESCRIPTOR && !listenerAssigned -> {
                    listenerAssigned = true
                    listener
                }
                type == String::class.java -> if (stringIndex++ == 0) PACKAGE_NAME else null
                type == Int::class.javaPrimitiveType || type == Int::class.java -> 0
                type == Long::class.javaPrimitiveType || type == Long::class.java -> 0L
                type == Boolean::class.javaPrimitiveType || type == Boolean::class.java -> false
                else -> return null
            }
        }.let { if (listenerAssigned) it.toTypedArray() else null }
    }

    override fun isClipboardServiceHealthy(): Boolean {
        if (getClipboardService() == null) return false
        val binder = clipboardBinder ?: return false
        return try {
            binder.isBinderAlive && binder.pingBinder()
        } catch (_: Exception) {
            false
        }
    }

    override fun destroy() {
        synchronized(clientLock) {
            clients.values.toList().forEach { client ->
                try {
                    client.token.unlinkToDeath(client.deathRecipient, 0)
                } catch (_: Exception) {
                }
            }
            clients.clear()
            unregisterSystemListenerLocked()
        }
        clipboardService = null
        clipboardBinder = null
        System.exit(0)
    }
}
