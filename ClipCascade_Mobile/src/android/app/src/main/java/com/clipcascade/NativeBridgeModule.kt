// android\app\src\main\java\com\clipcascade\NativeBridgeModule.kt
package com.clipcascade

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.Promise
import androidx.work.WorkManager
import android.webkit.CookieManager
import com.facebook.react.bridge.UiThreadUtil
import android.net.Uri
import android.os.TransactionTooLargeException
import android.os.Build
import android.view.inputmethod.EditorInfo
import android.provider.OpenableColumns
import android.util.Base64
import android.content.Intent
import android.content.ActivityNotFoundException
import android.provider.DocumentsContract
import android.content.ClipData
import android.content.ClipboardManager
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.widget.EditText
import com.facebook.react.uimanager.UIManagerModule
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import android.util.Base64OutputStream


class NativeBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        // Shared across module reloads: startup cleanup must also protect files
        // owned by another live module in this process, including finished streams.
        private val cipherFileLock = Any()
        private val activeCipherFiles = mutableSetOf<File>()

        private fun createCipherFile(cacheDir: File): File = synchronized(cipherFileLock) {
            File.createTempFile("clipboard-cipher-", ".tmp", cacheDir).also { activeCipherFiles.add(it) }
        }

        private fun deleteCipherFile(file: File) = synchronized(cipherFileLock) {
            try {
                if (file.exists() && !file.delete()) {
                    android.util.Log.w("ClipboardPreparation", "Could not delete cipher temporary file")
                }
            } finally {
                activeCipherFiles.remove(file)
            }
        }

        private fun cleanAbandonedCipherFiles(cacheDir: File) = synchronized(cipherFileLock) {
            cacheDir.listFiles()?.forEach { file ->
                if (file.isFile && file.name.startsWith("clipboard-cipher-")
                    && file.name.endsWith(".tmp") && file !in activeCipherFiles) {
                    deleteCipherFile(file)
                }
            }
        }
    }

    private val asyncBridge = AsyncStorageBridge(reactContext)
    private val stompSockets = NativeStompSocket(reactContext)
    private val clipboardReadGeneration = AtomicLong()
    @Volatile private var ownClipboardImageUri: String? = null
    // File/image reads must not occupy React Native's shared module queue.
    // One worker also avoids concurrently loading multiple large attachments.
    private val clipboardReads = Executors.newSingleThreadExecutor { task ->
        Thread(task, "ClipboardPreparation").apply { isDaemon = true }
    }

    init {
        // Process death skips normal cleanup. Reclaim its files before any new
        // cipher work, off the UI/module queue; preserve unrelated cache content.
        clipboardReads.execute {
            runCatching { cleanAbandonedCipherFiles(reactContext.cacheDir) }
                .onFailure { android.util.Log.w("ClipboardPreparation", "Cipher cache cleanup failed", it) }
        }
    }

    override fun getName(): String {
        return "NativeBridgeModule"
    }

    @ReactMethod
    fun connectStompSocket(id: Double, url: String, protocols: ReadableArray) {
        stompSockets.connect(id.toInt(), url, protocols)
    }

    @ReactMethod
    fun sendStompFrame(id: Double, frame: String, terminated: Boolean, promise: Promise) {
        stompSockets.send(id.toInt(), frame, terminated, promise)
    }

    @ReactMethod
    fun sendStompBinaryFrame(id: Double, frame: String, promise: Promise) {
        stompSockets.send(id.toInt(), frame, false, promise, true)
    }

    @ReactMethod
    fun sendStompBinaryChunk(id: Double, chunk: String, last: Boolean, promise: Promise) {
        if (chunk.length > 43692) { promise.reject("STOMP_CHUNK_SIZE", "Bridge chunk too large"); return }
        stompSockets.send(id.toInt(), chunk, false, promise, true, last)
    }

    @ReactMethod
    fun closeStompSocket(id: Double, code: Double, reason: String, force: Boolean) {
        stompSockets.close(id.toInt(), code.toInt(), reason, force)
    }

    @ReactMethod
    fun readProtectedValue(name: String, promise: Promise) {
        try {
            promise.resolve(ProtectedStorage.read(asyncBridge, name))
        } catch (error: Exception) {
            promise.reject("PROTECTED_STORAGE_READ", "Could not read protected ClipCascade data", error)
        }
    }

    @ReactMethod
    fun writeProtectedValue(name: String, value: String, promise: Promise) {
        try {
            ProtectedStorage.write(asyncBridge, name, value)
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("PROTECTED_STORAGE_WRITE", "Could not save protected ClipCascade data", error)
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getServiceRunIdSync(): String? = ServiceRunRegistry.currentId()

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun resetIdleServiceStateSync(): Boolean = ServiceRunRegistry.withIdle {
        asyncBridge.setValue("sync_requested", asyncBridge.isSyncRequested().toString())
        asyncBridge.setValue("wsIsRunning", "false")
        asyncBridge.setValue("wsStatusMessage", "")
        asyncBridge.setValue("p2pStatusMessage", "")
    } ?: false

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun claimServiceRunSync(): String? = ServiceRunRegistry.withIdle {
        val id = ServiceRunRegistry.claim()!!
        if (!asyncBridge.setValue("sync_requested", "true") ||
            !asyncBridge.setValue("wsIsRunning", "true") ||
            !asyncBridge.setValue("wsForegroundServiceTerminated", "false")) {
            ServiceRunRegistry.release(id)
            null
        } else {
            id
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun activateServiceRunSync(id: String): Boolean {
        if (!ServiceRunRegistry.activate(id)) return false
        ScheduleService.removeNotificationIfPresent(reactApplicationContext)
        return true
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isServiceRunCurrentSync(id: String): Boolean = ServiceRunRegistry.isCurrent(id)

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun requestServiceRunStopSync(id: String?, disableSync: Boolean): Boolean {
        val stopState = {
            val requested = !disableSync && asyncBridge.isSyncRequested()
            asyncBridge.setValue("sync_requested", requested.toString()) &&
                asyncBridge.setValue("wsIsRunning", "false")
        }
        return if (id == null) {
            ServiceRunRegistry.withIdle(stopState) ?: false
        } else {
            ServiceRunRegistry.withOwner(id) {
                ServiceRunRegistry.stop(id)
                stopState()
            } ?: false
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun setServiceRunValueSync(id: String, key: String, value: String): Boolean =
        ServiceRunRegistry.withOwner(id) { asyncBridge.setValue(key, value) } ?: false

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun releaseServiceRunSync(id: String): Boolean = ServiceRunRegistry.release(id)

    // Keep secure input semantics, but never reveal the most recently typed character.
    @ReactMethod
    fun setPasswordVisibility(viewTag: Double, visible: Boolean, promise: Promise) {
        val uiManager = reactApplicationContext.getNativeModule(UIManagerModule::class.java)
        if (uiManager == null) {
            promise.reject("PASSWORD_INPUT_ERROR", "UI manager is unavailable")
            return
        }
        uiManager.addUIBlock { views ->
            try {
                val input = views.resolveView(viewTag.toInt()) as EditText
                // Ask the IME not to learn this field, whether its text is hidden or visible.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    input.imeOptions = input.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                }
                val start = input.selectionStart
                val end = input.selectionEnd
                // Explicitly clear our custom transformation when revealing the password.
                input.transformationMethod = if (visible) null else object : PasswordTransformationMethod() {
                    override fun getTransformation(source: CharSequence, view: View): CharSequence =
                        object : CharSequence {
                            override val length: Int get() = source.length
                            override fun get(index: Int): Char = '\u2022'
                            override fun subSequence(startIndex: Int, endIndex: Int): CharSequence =
                                "\u2022".repeat(endIndex - startIndex)
                            override fun toString(): String = "\u2022".repeat(length)
                        }
                }
                if (start >= 0 && end >= 0) input.setSelection(start, end)
                promise.resolve(null)
            } catch (error: Exception) {
                promise.reject("PASSWORD_INPUT_ERROR", "Could not configure password masking", error)
            }
        }
    }

    @ReactMethod
    fun takePendingShare(promise: Promise) {
        promise.resolve(PendingShares.take())
    }

    @ReactMethod
    fun discardPendingShare(promise: Promise) {
        PendingShares.clear()
        promise.resolve(null)
    }

    @ReactMethod
    fun clearCookies(promise: Promise) {
        // The callback requires a Looper. Do not start login until removal finishes.
        UiThreadUtil.runOnUiThread {
            try {
                val cookieManager = CookieManager.getInstance()
                cookieManager.removeAllCookies {
                    try {
                        cookieManager.flush()
                        promise.resolve("Cookies cleared successfully!")
                    } catch (e: Exception) {
                        promise.reject("COOKIE_ERROR", "Failed to clear cookies", e)
                    }
                }
            } catch (e: Exception) {
                promise.reject("COOKIE_ERROR", "Failed to clear cookies", e)
            }
        }
    }
    
    @ReactMethod
    fun startWorkManager(promise: Promise) {
        try {
            MainActivity.scheduleJob(reactApplicationContext)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCHEDULE_ERROR", "Failed to start periodic checks", e)
        }
    }

    @ReactMethod
    fun stopWorkManager(promise: Promise) {
        try {
            WorkManager.getInstance(reactApplicationContext).cancelAllWorkByTag(MainActivity.WORK_NAME)
            ScheduleService.removeNotificationIfPresent(reactApplicationContext)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCHEDULE_ERROR", "Failed to stop periodic checks", e)
        }
    }

    @ReactMethod
    fun getFileSize(contentUri: String, promise: Promise) {
        try {
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)
            var size: Long = -1
            if (uri.scheme == "file") {
                val file = File(requireNotNull(uri.path))
                require(file.isFile && file.canRead()) { "Unreadable file: $uri" }
                promise.resolve(file.length().toString())
                return
            }
            val projection = arrayOf(OpenableColumns.SIZE)

            try {
                reactApplicationContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (cursor.moveToFirst() && sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        size = cursor.getLong(sizeIndex)
                    }
                }
            } catch (_: Exception) {
                // Some readable providers do not implement metadata queries.
            }
            if (size < 0L) {
                size = reactApplicationContext.contentResolver.openInputStream(uri)?.use { stream ->
                    val buffer = ByteArray(8192)
                    var total = 0L
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        total += count
                    }
                    total
                } ?: throw IOException("Unable to open file: $trimmedUri")
            }
            promise.resolve(size.toString())
        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to get file size: ${e.message}")
        }
    }

    @ReactMethod
    fun getFileName(contentUri: String, promise: Promise) {
        try {
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)
            if (uri.scheme == "file") {
                promise.resolve(File(requireNotNull(uri.path)).name)
                return
            }
            var fileName: String? = null
            val projection = arrayOf(OpenableColumns.DISPLAY_NAME)
            try {
                reactApplicationContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (cursor.moveToFirst() && nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                        fileName = cursor.getString(nameIndex)
                    }
                }
            } catch (_: Exception) {
                // Fall back to the URI when a provider cannot return a display name.
            }
            if (fileName.isNullOrEmpty()) fileName = uri.lastPathSegment
            if (fileName.isNullOrEmpty()) {
                promise.reject("ERROR", "Failed to get file name: null for URI: ${trimmedUri}")
                return
            }
            promise.resolve(fileName)
        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to get file name: ${e.message}")
        }
    }

    // The classic RN bridge has no byte-buffer value. Numeric arrays require
    // per-byte JNI calls, so use bounded Base64 bridge chunks, never a whole
    // attachment string. Streams remain on the preparation executor.
    private val attachmentStreams = mutableMapOf<String, Pair<Long, java.io.InputStream>>()
    private var nextAttachmentStream = 0L

    private data class ClipboardCipherJob(
        val generation: Long, val cipher: javax.crypto.Cipher, val file: File,
        val output: FileOutputStream, val decrypt: Boolean, val tag: ByteArray
    )
    private val clipboardCiphers = mutableMapOf<String, ClipboardCipherJob>()

    private fun bridgeBytes(values: ReadableArray): ByteArray {
        require(values.size() <= 32 * 1024) { "Bridge chunk too large" }
        return ByteArray(values.size()) { index ->
            val value = values.getInt(index)
            require(value in 0..255) { "Invalid byte" }
            value.toByte()
        }
    }

    // AES work and temporary output stay off RN/UI threads. Decrypted output is
    // exposed only after doFinal authenticates the complete GCM message.
    @ReactMethod
    fun beginClipboardCipher(key: String, decrypt: Boolean, nonce: ReadableArray, tag: ReadableArray, promise: Promise) {
        val generation = clipboardReadGeneration.get()
        val iv = bridgeBytes(nonce)
        val authTag = bridgeBytes(tag)
        clipboardReads.execute {
            try {
                if (generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                val secret = javax.crypto.spec.SecretKeySpec(Base64.decode(key, Base64.DEFAULT), "AES")
                if (decrypt) {
                    require(iv.size in 8..32 && authTag.size == 16)
                    cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secret, javax.crypto.spec.GCMParameterSpec(128, iv))
                } else {
                    cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, secret)
                }
                val file = createCipherFile(reactApplicationContext.cacheDir)
                val id = (++nextAttachmentStream).toString()
                val output = try { FileOutputStream(file) } catch (error: Exception) { deleteCipherFile(file); throw error }
                clipboardCiphers[id] = ClipboardCipherJob(generation, cipher, file, output, decrypt, authTag)
                promise.resolve(id)
            } catch (error: Exception) { promise.reject(if (error is java.io.InterruptedIOException) "CLIPBOARD_SUPERSEDED" else "CIPHER_ERROR", "Cannot begin clipboard cipher", error) }
        }
    }

    @ReactMethod
    fun appendClipboardCipher(id: String, encoded: String, promise: Promise) {
        clipboardReads.execute {
            try {
                require(encoded.length <= 43692) { "Bridge chunk too large" }
                val block = Base64.decode(encoded, Base64.NO_WRAP)
                require(block.size <= 32 * 1024) { "Bridge chunk too large" }
                val job = clipboardCiphers[id] ?: throw IOException("Cipher closed")
                if (job.generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                job.cipher.update(block)?.let { job.output.write(it) }
                promise.resolve(null)
            } catch (error: Exception) { promise.reject(if (error is java.io.InterruptedIOException) "CLIPBOARD_SUPERSEDED" else "CIPHER_ERROR", "Clipboard cipher interrupted", error) }
        }
    }

    @ReactMethod
    fun finishClipboardCipher(id: String, promise: Promise) {
        clipboardReads.execute {
            val job = clipboardCiphers.remove(id)
            try {
                requireNotNull(job) { "Cipher closed" }
                if (job.generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                job.output.write(if (job.decrypt) job.cipher.doFinal(job.tag) else job.cipher.doFinal())
                job.output.close()
                val result = com.facebook.react.bridge.Arguments.createMap()
                if (!job.decrypt) {
                    val tagBytes = ByteArray(16)
                    java.io.RandomAccessFile(job.file, "rw").use { file ->
                        file.seek(file.length() - 16)
                        file.readFully(tagBytes)
                        file.setLength(file.length() - 16)
                    }
                    result.putString("nonce", Base64.encodeToString(job.cipher.iv, Base64.NO_WRAP))
                    result.putString("tag", Base64.encodeToString(tagBytes, Base64.NO_WRAP))
                }
                if (job.generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                val stream = object : java.io.FileInputStream(job.file) {
                    override fun close() { try { super.close() } finally { deleteCipherFile(job.file) } }
                }
                attachmentStreams[id] = job.generation to stream
                result.putString("id", id)
                promise.resolve(result)
            } catch (error: Exception) {
                runCatching { job?.output?.close() }
                job?.file?.let { deleteCipherFile(it) }
                promise.reject(if (error is java.io.InterruptedIOException) "CLIPBOARD_SUPERSEDED" else "CIPHER_ERROR", "Clipboard authentication or cipher failed", error)
            }
        }
    }

    @ReactMethod
    fun abortClipboardCipher(id: String, promise: Promise) {
        clipboardReads.execute {
            val job = clipboardCiphers.remove(id)
            try { job?.output?.close(); promise.resolve(null) }
            catch (error: Exception) { promise.reject("CIPHER_ERROR", "Cannot close clipboard cipher", error) }
            finally { job?.file?.let { deleteCipherFile(it) } }
        }
    }

    @ReactMethod
    fun openClipboardBytes(uri: String, promise: Promise) {
        val generation = clipboardReadGeneration.get()
        clipboardReads.execute {
            try {
                attachmentStreams.entries.removeAll { (_, value) ->
                    if (value.first != generation) { value.second.close(); true } else false
                }
                if (generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                val stream = reactApplicationContext.contentResolver.openInputStream(Uri.parse(uri.trim()))
                    ?: throw IOException("Cannot open attachment")
                val id = (++nextAttachmentStream).toString()
                attachmentStreams[id] = generation to stream
                promise.resolve(id)
            } catch (error: Exception) { promise.reject(if (error is java.io.InterruptedIOException) "CLIPBOARD_SUPERSEDED" else "ERROR", "Cannot open attachment", error) }
        }
    }

    @ReactMethod
    fun readClipboardBytes(id: String, promise: Promise) {
        clipboardReads.execute {
            try {
                val (generation, stream) = attachmentStreams[id] ?: throw IOException("Attachment closed")
                if (generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                val buffer = ByteArray(32 * 1024)
                val count = stream.read(buffer)
                if (generation != clipboardReadGeneration.get()) throw java.io.InterruptedIOException()
                promise.resolve(if (count < 0) "" else Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP))
            } catch (error: Exception) {
                attachmentStreams.remove(id)?.second?.close()
                promise.reject(if (error is java.io.InterruptedIOException) "CLIPBOARD_SUPERSEDED" else "ERROR", "Attachment read interrupted", error)
            }
        }
    }

    @ReactMethod
    fun closeClipboardBytes(id: String, promise: Promise) {
        clipboardReads.execute {
            try { attachmentStreams.remove(id)?.second?.close(); promise.resolve(null) }
            catch (error: Exception) { promise.reject("ERROR", "Cannot close attachment", error) }
        }
    }

    @ReactMethod
    fun getFileAsBase64(contentUri: String, promise: Promise) {
        val generation = clipboardReadGeneration.get()
        try {
            clipboardReads.execute { readFileAsBase64(contentUri, generation, promise) }
        } catch (e: java.util.concurrent.RejectedExecutionException) {
            promise.reject("ERROR", "Clipboard preparation has stopped", e)
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun cancelClipboardReadsSync(): Double = clipboardReadGeneration.incrementAndGet().toDouble()

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isOwnClipboardImageSync(uri: String): Boolean = uri == ownClipboardImageUri

    private fun readFileAsBase64(contentUri: String, generation: Long, promise: Promise) {
        try {
            fun checkCurrent() {
                if (generation != clipboardReadGeneration.get() || Thread.currentThread().isInterrupted) {
                    throw java.io.InterruptedIOException("Clipboard superseded")
                }
            }
            checkCurrent()
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)
            reactApplicationContext.contentResolver.openInputStream(uri)?.use { inputStream ->
                val output = ByteArrayOutputStream()
                Base64OutputStream(output, Base64.DEFAULT).use { encoder ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) {
                        checkCurrent()
                        val count = inputStream.read(buffer)
                        if (count < 0) break
                        encoder.write(buffer, 0, count)
                    }
                    checkCurrent()
                }
                checkCurrent()
                promise.resolve(output.toString(Charsets.US_ASCII.name()))
            } ?: run {
                promise.reject("ERROR", "Failed to open file stream. Invalid URI or file access denied. ${trimmedUri}")
            }
        } catch (e: java.io.InterruptedIOException) {
            promise.reject("CLIPBOARD_SUPERSEDED", "Clipboard superseded", e)
        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to get file bytes: ${e.message}")
        }
    }

    fun convertAnySupportedImageToPng(imageBytes: ByteArray): ByteArray? {
        // 1. Decode to a Bitmap
        val bitmap: Bitmap? = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)

        if (bitmap == null) {
            // The data might be corrupted or in an unsupported format
            return null
        }

        // 2. Compress as PNG into an in-memory stream
        val outputStream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, outputStream) // 100% quality
        
        // 3. Retrieve the PNG bytes
        return outputStream.toByteArray()
    }

    private fun writeAndroidClipboard(clipData: ClipData, contentType: String, promise: Promise) {
        val writeId = java.util.UUID.randomUUID().toString()
        try {
            val extras = clipData.description.extras?.let { android.os.PersistableBundle(it) }
                ?: android.os.PersistableBundle()
            extras.putString(ClipboardObservations.OWN_WRITE_KEY, writeId)
            clipData.description.extras = extras
            ClipboardObservations.expectOwnWrite(writeId)
            val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(clipData)
            promise.resolve("$contentType copied to clipboard.")
        } catch (error: Exception) {
            ClipboardObservations.forgetOwnWrite(writeId)
            // Android can wrap Binder failures inside RuntimeException.
            val causes = generateSequence(error as Throwable) { it.cause }.toList()
            val sizeError = causes.firstOrNull { it is TransactionTooLargeException }
            val accessError = causes.firstOrNull { it is SecurityException }
            when {
                sizeError != null -> promise.reject(
                    "ANDROID_CLIPBOARD_SIZE_LIMIT",
                    "Android could not copy this $contentType because it is too large for a system clipboard transaction. " +
                        "This is an Android operating-system limitation, separate from ClipCascade's configured " +
                        "clipboard size limit. Increasing or disabling the limit in ClipCascade cannot bypass " +
                        "Android's restriction. " +
                        (if (contentType == "text") "Copy a smaller portion of the text, or transfer it as a text file instead."
                         else "Try copying a smaller image."),
                    error,
                )
                accessError != null -> promise.reject(
                    "ANDROID_CLIPBOARD_ACCESS_DENIED",
                    "Android denied access to write $contentType to the clipboard. " +
                        "Check device clipboard restrictions. (${accessError.javaClass.simpleName}: ${accessError.message})",
                    error,
                )
                else -> promise.reject(
                    "ANDROID_CLIPBOARD_WRITE_FAILED",
                    "Android could not write $contentType to the clipboard. " +
                        "(${error.javaClass.simpleName}: ${error.message})",
                    error,
                )
            }
        }
    }

    @ReactMethod
    fun copyTextToClipboard(text: String, promise: Promise) {
        try {
            writeAndroidClipboard(ClipData.newPlainText(null, text), "text", promise)
        } catch (error: Exception) {
            promise.reject("TEXT_PREPARATION_ERROR", "Could not prepare text for the clipboard: ${error.message}", error)
        }
    }

    @ReactMethod
    fun copyBase64ImageToClipboardUsingCache(base64String: String, promise: Promise) {
        val generation = clipboardReadGeneration.get()
        try {
            // Clear existing cached images to prevent accumulation
            clearImageCacheInternal()

            // Validate and convert to png
            val imageBytes = convertAnySupportedImageToPng(Base64.decode(base64String, Base64.DEFAULT))
            if (imageBytes == null) {
                promise.reject("INVALID_IMAGE", "The provided bytes do not represent a valid image.")
                return
            }
            if (generation != clipboardReadGeneration.get()) {
                promise.reject("CLIPBOARD_SUPERSEDED", "Clipboard superseded")
                return
            }

            // Create a unique file in the cache directory
            val fileName = "clipboard_image_${System.currentTimeMillis()}.png"
            val cacheFile = File(reactApplicationContext.cacheDir, fileName)

            // Use a FileOutputStream to write the byte array
            FileOutputStream(cacheFile).use { output ->
                output.write(imageBytes)
            }

            // Convert file path to a content URI via FileProvider
            val authority = "${reactApplicationContext.packageName}.fileprovider"
            val imageUri: Uri = FileProvider.getUriForFile(reactApplicationContext, authority, cacheFile)

            // Copy the URI to clipboard
            val clipData = ClipData.newUri(reactApplicationContext.contentResolver, "Image", imageUri)
            if (generation != clipboardReadGeneration.get()) {
                cacheFile.delete()
                promise.reject("CLIPBOARD_SUPERSEDED", "Clipboard superseded")
                return
            }
            ownClipboardImageUri = imageUri.toString()
            writeAndroidClipboard(clipData, "image", promise)

        } catch (e: Exception) {
            promise.reject("IMAGE_PREPARATION_ERROR", "Could not prepare the image for the clipboard: ${e.message}", e)
        }
    }

    @ReactMethod
    fun clearImageCache(promise: Promise) {
        try {
            clearImageCacheInternal()
            promise.resolve("Cache cleared successfully.")
        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to clear cache: ${e.message}")
        }
    }

    fun clearImageCacheInternal() {
        val cacheDir = reactApplicationContext.cacheDir
        val files = cacheDir.listFiles { file ->
            file.name.startsWith("clipboard_image_") && file.name.endsWith(".png")
        }

        if (files != null) {
            for (file in files) {
                file.delete()
            }
        }
    }

    @ReactMethod
    fun isDownloadDirectoryAvailable(contentUri: String, promise: Promise) {
        try {
            val uri = Uri.parse(contentUri)
            val hasWriteGrant = reactApplicationContext.contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isWritePermission
            }
            val directory = DocumentFile.fromTreeUri(reactApplicationContext, uri)
            promise.resolve(hasWriteGrant && directory != null && directory.isDirectory && directory.canWrite())
        } catch (e: Exception) {
            // Revoked grants and unavailable document providers require selecting a folder again.
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openDownloadDirectory(contentUri: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val treeUri = Uri.parse(contentUri)
                require(treeUri.scheme == "content" && DocumentsContract.isTreeUri(treeUri)) {
                    "Invalid download folder URI"
                }
                val documentUri = DocumentsContract.buildDocumentUriUsingTree(
                    treeUri, DocumentsContract.getTreeDocumentId(treeUri)
                )
                val context: Context = currentActivity ?: reactApplicationContext
                val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(documentUri, DocumentsContract.Document.MIME_TYPE_DIR)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    if (currentActivity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                try {
                    context.startActivity(viewIntent)
                } catch (_: ActivityNotFoundException) {
                    // Some file managers cannot view a document directory directly.
                    // The system Files picker can still show its contents at this URI.
                    val browseIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(DocumentsContract.EXTRA_INITIAL_URI, documentUri)
                        if (currentActivity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(browseIntent)
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("OPEN_FOLDER_ERROR", "Unable to open this folder in Files: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun saveBase64Files(contentUri: String, content: String, promise: Promise) {
        try {
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)

            // Deserialize JSON into a Map
            val fileMap = Json.decodeFromString<Map<String, String>>(content)

            // Turn the Uri into a DocumentFile directory (from SAF)
            val docFile = DocumentFile.fromTreeUri(reactApplicationContext, uri)
                ?: throw IllegalArgumentException("Invalid directory URI: $uri")

            for ((fileName, base64Data) in fileMap) {
                // Decode the Base64 string to raw bytes
                val decodedBytes = Base64.decode(base64Data, Base64.DEFAULT)

                // Get a unique filename so it doesn't collide with existing files.
                val uniqueName = getUniqueName(docFile, fileName)

                // Create a file in the chosen directory.
                val newFile = docFile.createFile(
                    "application/octet-stream", // or use a MIME type suitable for your file type
                    uniqueName
                ) ?: throw IOException("Failed to create file: $uniqueName")

                // Write the decoded bytes to the newly created file
                reactApplicationContext.contentResolver.openOutputStream(newFile.uri).use { outputStream ->
                    if (outputStream == null) {
                        throw IOException("Failed to open output stream for: $uniqueName")
                    }
                    outputStream.write(decodedBytes)
                    outputStream.flush()
                }
            }

            promise.resolve("Files saved successfully.")
        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to save files: ${e.message}")
        }
    }

    /**
    * Generates a unique file name by inserting (1), (2), etc. before the extension if
    * a file with the same name already exists in the directory.
    */
    private fun getUniqueName(dir: DocumentFile, originalName: String): String {
        // Separate the filename from its extension
        val extensionIndex = originalName.lastIndexOf('.')
        val nameWithoutExt = if (extensionIndex > 0) originalName.substring(0, extensionIndex) else originalName
        val extension = if (extensionIndex > 0) originalName.substring(extensionIndex) else ""

        // Start with the original name
        var candidate = originalName
        var counter = 1

        // Check if a file with this candidate name already exists
        while (dir.findFile(candidate) != null) {
            // If yes, generate a new candidate by appending (x) before the extension
            candidate = "$nameWithoutExt($counter)$extension"
            counter++
        }

        return candidate
    }


    /**
     * JS calls this synchronously, passing a JS array of keys:
     *    NativeBridgeModule.getFlagsSync(["foo","bar"])
     * returns a JSON string: {"foo":"…","bar":null}
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getFlagsSync(keys: ReadableArray): String {
        val list = mutableListOf<String>()
        for (i in 0 until keys.size()) {
            keys.getString(i)?.let { list.add(it) }
        }
        return asyncBridge.getValuesForKeys(list)
    }


    override fun onCatalystInstanceDestroy() {
        stompSockets.shutdown()
        clipboardReadGeneration.incrementAndGet()
        // Queued jobs must run their cancellation checks and settle promises.
        clipboardReads.execute {
            attachmentStreams.values.forEach { runCatching { it.second.close() } }
            attachmentStreams.clear()
            clipboardCiphers.values.forEach { runCatching { it.output.close() }; deleteCipherFile(it.file) }
            clipboardCiphers.clear()
        }
        clipboardReads.shutdown()
        asyncBridge.disconnect()
    }
}
