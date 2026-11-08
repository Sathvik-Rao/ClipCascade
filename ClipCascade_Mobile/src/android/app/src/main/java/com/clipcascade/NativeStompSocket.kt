package com.clipcascade

import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.network.ForwardingCookieHandler
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/** A STOMP byte stream with bounded OkHttp buffering, not a new clipboard protocol. */
internal class NativeStompSocket(private val context: ReactApplicationContext) {
    private val sockets = ConcurrentHashMap<Int, Connection>()
    private val cookies = ForwardingCookieHandler(context)

    fun connect(id: Int, url: String, protocols: ReadableArray) {
        val connection = Connection(id)
        sockets[id] = connection
        try {
            val builder = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
            ServerTls.applyTo(builder)
            val request = Request.Builder().url(url)
            val address = request.build().url
            cookies.get(address.toUri(), emptyMap()).forEach { (key, values) ->
                if (key.equals("Cookie", true)) request.addHeader("Cookie", values.joinToString("; "))
            }
            val origin = address.newBuilder().username("").password("").encodedPath("/")
                .query(null).fragment(null).build().toString().removeSuffix("/")
            request.header("Origin", origin)
            val versions = (0 until protocols.size()).mapNotNull { protocols.getString(it) }
            if (versions.isNotEmpty()) request.header("Sec-WebSocket-Protocol", versions.joinToString(","))
            connection.socket = builder.build().newWebSocket(request.build(), connection)
        } catch (error: Exception) {
            connection.failed(error)
        }
    }

    fun send(id: Int, frame: String, terminated: Boolean, promise: Promise, binary: Boolean = false, drain: Boolean = true) {
        val connection = sockets[id]
        if (connection == null) {
            promise.reject("STOMP_CLOSED", "STOMP connection is closed")
            return
        }
        try {
            connection.writer.execute {
                try {
                    connection.write(frame, terminated, binary, drain)
                    promise.resolve(null)
                } catch (error: Exception) {
                    promise.reject("STOMP_SEND_FAILED", error.message, error)
                    connection.close(1011, "STOMP send failed", true)
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            promise.reject("STOMP_CLOSED", "STOMP connection is closed", error)
        }
    }

    fun close(id: Int, code: Int, reason: String, force: Boolean) {
        sockets[id]?.close(code, reason, force)
    }

    fun shutdown() {
        sockets.values.toList().forEach { it.close(1000, "Service stopped", true) }
    }

    private inner class Connection(private val id: Int) : WebSocketListener() {
        @Volatile var socket: WebSocket? = null
        @Volatile private var open = false
        @Volatile private var closing = false
        val writer = Executors.newSingleThreadExecutor { task ->
            Thread(task, "StompWriter-$id").apply { isDaemon = true }
        }

        private fun event(type: String, data: String = "", code: Int = 0) {
            if (!context.hasActiveReactInstance()) return
            val payload = Arguments.createMap().apply {
                putInt("id", id); putString("type", type)
                // Keep STOMP NUL bytes out of bridge strings in both directions.
                putString("data", if (type == "message") JSONObject.quote(data) else data)
                putInt("code", code)
            }
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("CLIPCASCADE_STOMP_SOCKET", payload)
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            if (closing) { webSocket.cancel(); return }
            open = true
            event("open")
        }

        override fun onMessage(webSocket: WebSocket, text: String) { event("message", text) }
        override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
            // STOMP consumes a continuous stream; keep binary bridge strings bounded.
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + 32 * 1024, bytes.size)
                event("binary", Base64.encodeToString(bytes.substring(offset, end).toByteArray(), Base64.NO_WRAP))
                offset = end
            }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finished(code, reason) }
        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) { failed(error) }

        fun failed(error: Throwable) {
            if (!closing) event("error", error.message ?: "STOMP connection failed")
            finished(1006, error.message ?: "STOMP connection failed")
        }

        private fun finished(code: Int, reason: String) {
            open = false
            closing = true
            if (sockets.remove(id, this)) event("close", reason, code)
            // Queued calls must settle their promises, rather than being discarded.
            writer.shutdown()
        }

        fun close(code: Int, reason: String, force: Boolean) {
            closing = true
            open = false
            if (force) socket?.cancel() else socket?.close(code, reason)
            if (socket == null) finished(code, reason)
        }

        fun write(frame: String, terminated: Boolean, binary: Boolean, drain: Boolean) {
            val target = socket ?: throw IOException("STOMP connection is closed")
            val bytes = if (binary) Base64.decode(frame, Base64.NO_WRAP) else frame.toByteArray(Charsets.UTF_8)
            var previous = target.queueSize()
            var lastProgress = SystemClock.elapsedRealtime()
            fun awaitCapacity(required: Long) {
                while (true) {
                    if (!open || closing) throw IOException("STOMP connection closed during send")
                    val queued = target.queueSize()
                    if (queued < previous) lastProgress = SystemClock.elapsedRealtime()
                    previous = queued
                    if (queued + required <= 1024 * 1024) return
                    if (SystemClock.elapsedRealtime() - lastProgress >= 30_000) {
                        throw IOException("STOMP connection stopped draining for 30 seconds")
                    }
                    Thread.sleep(20)
                }
            }
            var offset = 0
            while (offset < bytes.size) {
                val count = minOf(16 * 1024, bytes.size - offset)
                awaitCapacity(count.toLong())
                if (!target.send(bytes.toByteString(offset, count))) throw IOException("STOMP send rejected")
                offset += count
            }
            if (terminated) {
                awaitCapacity(1)
                if (!target.send(byteArrayOf(0).toByteString())) throw IOException("STOMP send rejected")
            }
            // Resolve only after the native transport has drained this frame.
            while (drain && target.queueSize() > 0) {
                awaitCapacity(1024L * 1024)
            }
        }
    }
}
