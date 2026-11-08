package com.clipcascade

import android.content.ClipData
import android.content.ContentResolver
import android.os.Build
import com.facebook.react.bridge.WritableMap

/** One observation history shared by the listener and the floating reader. */
object ClipboardObservations {
    const val OWN_WRITE_KEY = "com.clipcascade.clipboard.write"
    private data class Snapshot(val content: ClipboardContent?, val timestamp: Long?)
    private var previous: Snapshot? = null
    private var revision = 0L
    private var shareAcceptedAt = 0L
    private val ownWrites = LinkedHashSet<String>()

    data class Update(val content: ClipboardContent, val revision: String, val isEcho: Boolean) {
        fun toMap(): WritableMap = content.toMap().apply {
            putString("clipboardRevision", revision)
            putBoolean("clipboardEcho", isEcho)
        }
    }

    @Synchronized
    fun expectOwnWrite(id: String) {
        ownWrites.add(id)
        if (ownWrites.size > 128) ownWrites.remove(ownWrites.first())
    }

    @Synchronized
    fun forgetOwnWrite(id: String) { ownWrites.remove(id) }

    @Synchronized
    fun currentRevision(): String = revision.toString()

    @Synchronized
    fun baseline(clip: ClipData?, resolver: ContentResolver): String {
        // A denied background read can return null. Do not erase a known
        // clipboard snapshot just because the app temporarily lacks focus.
        if (clip != null) observe(clip, resolver)
        return revision.toString()
    }

    @Synchronized
    fun beginShare(clip: ClipData?, resolver: ContentResolver): String {
        shareAcceptedAt = System.currentTimeMillis()
        return baseline(clip, resolver)
    }

    @Synchronized
    fun observe(clip: ClipData?, resolver: ContentResolver): Update? {
        // Android can return null when background access is denied. A null
        // read must not turn a later reread into a new observation.
        if (clip == null) return null
        val content = ClipboardContent.fromClipboard(clip, resolver)
        // The timestamp distinguishes a fresh copy of identical text from a
        // second read of the same clipboard item on Android 8 and newer.
        val timestamp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) clip.description.timestamp else null
        val snapshot = Snapshot(content, timestamp)
        if (snapshot == previous) return null
        previous = snapshot
        revision++
        // Sharing may reach onCreate before Android grants clipboard access.
        // A later focused reread of an older item is still only a baseline.
        if (timestamp != null && timestamp < shareAcceptedAt) return null
        val ownWrite = clip.description.extras?.getString(OWN_WRITE_KEY)
        val isEcho = ownWrite != null && ownWrites.remove(ownWrite)
        return content?.let { Update(it, revision.toString(), isEcho) }
    }
}
