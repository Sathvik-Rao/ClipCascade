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


class NativeBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val asyncBridge = AsyncStorageBridge(reactContext)

    override fun getName(): String {
        return "NativeBridgeModule"
    }

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

    @ReactMethod
    fun getFileAsBase64(contentUri: String, promise: Promise) {
        try {
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)
            reactApplicationContext.contentResolver.openInputStream(uri)?.use { inputStream ->
                val bytes = inputStream.readBytes()
                val base64String = Base64.encodeToString(bytes, Base64.DEFAULT)
                promise.resolve(base64String)
            } ?: run {
                promise.reject("ERROR", "Failed to open file stream. Invalid URI or file access denied. ${trimmedUri}")
            }
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
        try {
            val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(clipData)
            promise.resolve("$contentType copied to clipboard.")
        } catch (error: Exception) {
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
        try {
            // Clear existing cached images to prevent accumulation
            clearImageCacheInternal()

            // Validate and convert to png
            val imageBytes = convertAnySupportedImageToPng(Base64.decode(base64String, Base64.DEFAULT))
            if (imageBytes == null) {
                promise.reject("INVALID_IMAGE", "The provided bytes do not represent a valid image.")
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
        asyncBridge.disconnect()
    }
}
