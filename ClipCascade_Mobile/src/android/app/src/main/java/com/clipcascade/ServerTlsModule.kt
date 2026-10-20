package com.clipcascade

import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ServerTlsModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "ServerTlsModule"

    @ReactMethod
    fun importBundle(uri: String, promise: Promise) {
        try {
            val bytes = requireNotNull(reactApplicationContext.contentResolver.openInputStream(Uri.parse(uri))) {
                "Unable to open CA bundle."
            }.use { stream ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = stream.read(buffer)
                    if (count == -1) break
                    require(output.size() + count <= 1024 * 1024) { "CA bundle exceeds 1 MiB." }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            val pem = ServerTls.certificates(bytes).joinToString("\n") { cert ->
                "-----BEGIN CERTIFICATE-----\n" +
                    Base64.encodeToString(cert.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n") +
                    "\n-----END CERTIFICATE-----\n"
            }
            promise.resolve(pem)
        } catch (e: Exception) {
            promise.reject("CA_IMPORT_ERROR", "Cannot import CA bundle: ${e.message}", e)
        }
    }

    @ReactMethod
    fun configure(serverUrl: String, pem: String, promise: Promise) {
        try {
            ServerTls.configure(serverUrl, pem)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CA_CONFIG_ERROR", "Cannot configure server TLS: ${e.message}", e)
        }
    }
}
