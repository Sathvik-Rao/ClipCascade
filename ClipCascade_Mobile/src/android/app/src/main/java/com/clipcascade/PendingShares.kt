package com.clipcascade

import android.os.SystemClock
import com.facebook.react.bridge.WritableMap

/** One short-lived startup slot, not an offline/retry queue. */
object PendingShares {
    private const val STARTUP_TIMEOUT_MS = 10_000L
    private data class Entry(val content: ClipboardContent, val createdAt: Long, val clipboardBaselineRevision: String)
    private var pending: Entry? = null

    @Synchronized
    fun add(content: ClipboardContent, clipboardBaselineRevision: String) {
        pending = Entry(content, SystemClock.elapsedRealtime(), clipboardBaselineRevision)
    }

    @Synchronized
    fun take(): WritableMap? {
        val entry = pending ?: return null
        pending = null
        return entry.content.toMap().apply {
            putString("clipboardBaselineRevision", entry.clipboardBaselineRevision)
            putBoolean("expired", SystemClock.elapsedRealtime() - entry.createdAt >= STARTUP_TIMEOUT_MS)
        }
    }

    @Synchronized
    fun clear() {
        pending = null
    }
}
