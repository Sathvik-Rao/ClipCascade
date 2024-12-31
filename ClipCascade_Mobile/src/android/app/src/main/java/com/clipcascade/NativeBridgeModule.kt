package com.clipcascade

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import androidx.work.WorkManager
import android.webkit.CookieManager
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.content.ClipData
import android.content.ClipboardManager
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

    override fun getName(): String {
        return "NativeBridgeModule"
    }

    @ReactMethod
    fun clearCookies(promise: Promise) {
        try {
            val cookieManager = CookieManager.getInstance()
            cookieManager.removeAllCookies(null)
            cookieManager.flush()
            promise.resolve("Cookies cleared successfully!")
        } catch (e: Exception) {
            promise.reject("COOKIE_ERROR", "Failed to clear cookies", e)
        }
    }
    
    @ReactMethod
    fun stopWorkManager() {
        WorkManager.getInstance(reactApplicationContext).cancelAllWorkByTag(MainActivity.WORK_NAME)
    }

    @ReactMethod
    fun getFileSize(contentUri: String, promise: Promise) {
        try {
            val trimmedUri = contentUri.trim()
            val uri = Uri.parse(trimmedUri)
            var size: Long = -1
            val projection = arrayOf(OpenableColumns.SIZE)

            reactApplicationContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                val sizeIndex = cursor.getColumnIndexOrThrow(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    size = cursor.getLong(sizeIndex)
                }
            }
            if (size == -1L) {
                promise.reject("ERROR", "Failed to get file size: -1 for URI: ${trimmedUri}")
                return
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
            var fileName: String? = null
            val projection = arrayOf(OpenableColumns.DISPLAY_NAME)
            reactApplicationContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)
                if (cursor.moveToFirst()) {
                    fileName = cursor.getString(nameIndex)
                }
            }
            if (fileName == null) {
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
            val clipboard = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(clipData)

            promise.resolve("Image copied to clipboard.")

        } catch (e: Exception) {
            promise.reject("ERROR", "Failed to copy image to clipboard: ${e.message}")
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
}
