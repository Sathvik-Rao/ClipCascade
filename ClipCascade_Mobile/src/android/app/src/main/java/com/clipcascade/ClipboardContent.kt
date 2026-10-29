package com.clipcascade

import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

/** Keep URI collections structured: commas are valid characters inside a URI. */
data class ClipboardContent(val type: String, val values: List<String>) {
    fun toMap(): WritableMap = Arguments.createMap().apply {
        putString("type", type)
        if (type == "files") {
            putArray("content", Arguments.fromList(values))
        } else {
            putString("content", values.first())
        }
    }

    companion object {
        private fun isImage(uri: Uri, resolver: ContentResolver, fallback: Boolean): Boolean {
            val mime = try { resolver.getType(uri) } catch (_: Exception) { null }
            return mime?.startsWith("image/") ?: fallback
        }

        fun fromClipboard(clip: ClipData, resolver: ContentResolver): ClipboardContent? {
            val items = (0 until clip.itemCount).map { clip.getItemAt(it) }
            // A content/file URI identifies an attachment. A web link accompanying
            // text does not turn copied text into a file transfer.
            val uris = items.mapNotNull { it.uri }
                .filter { it.scheme == "content" || it.scheme == "file" }
            if (uris.isNotEmpty()) {
                val image = uris.size == 1 && isImage(
                    uris.first(), resolver, clip.description.hasMimeType("image/*")
                )
                return ClipboardContent(if (image) "image" else "files", uris.map(Uri::toString))
            }
            val text = items.mapNotNull { it.text?.toString() ?: it.uri?.toString() }.joinToString("\n")
            return text.takeIf { it.isNotEmpty() }?.let { ClipboardContent("text", listOf(it)) }
        }

        @Suppress("DEPRECATION")
        fun fromIntent(intent: Intent, resolver: ContentResolver): ClipboardContent? {
            if (intent.action == Intent.ACTION_PROCESS_TEXT) {
                return intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
                    ?.let { ClipboardContent("text", listOf(it)) }
            }
            if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
            val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
            } else {
                listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            }
            val uris = streams.ifEmpty {
                intent.clipData?.let { clip ->
                    (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
                }.orEmpty()
            }.distinct()
            if (uris.isNotEmpty()) {
                // ACTION_SEND_MULTIPLE deliberately transfers images as files.
                val image = intent.action == Intent.ACTION_SEND && uris.size == 1 &&
                    isImage(uris.first(), resolver, intent.type?.startsWith("image/") == true)
                return ClipboardContent(if (image) "image" else "files", uris.map(Uri::toString))
            }
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                ?: intent.clipData?.let { clip ->
                    (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).text?.toString() }
                        .joinToString("\n").takeIf { it.isNotEmpty() }
                }
            return text?.let { ClipboardContent("text", listOf(it)) }
        }
    }
}
