// android\app\src\main\java\com\clipcascade\ClipCascadeTrustManager.kt
package com.clipcascade

import android.content.Context
import android.util.Log
import java.io.File
import java.io.InputStream
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trusts everything the platform already trusts, plus anything signed by the CA
 * certificate the user imported from the login screen ("Extra Config" -> "Server CA
 * Certificate"). This makes a server behind a private/internal PKI reachable over
 * HTTPS/WSS without weakening verification for any other host.
 *
 * The certificate is stored in the app's private files directory and read back here,
 * so entry points that never run the login screen (boot receiver, headless service)
 * pick it up without a round trip through JavaScript.
 *
 * On import or removal only the delegate list is swapped; the trust manager instance
 * stays the same. That is what lets a change take effect without restarting the app:
 * React Native caches its OkHttpClient, but that client holds *this* object and
 * re-reads [delegates] on every handshake.
 */
object ClipCascadeTrustManager : X509TrustManager {

    private const val TAG = "ClipCascadeTrustManager"
    private const val CA_FILE_NAME = "clipcascade_ca.pem"

    @Volatile
    private var delegates: List<X509TrustManager> = emptyList()

    private val sslContext: SSLContext by lazy {
        SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(this@ClipCascadeTrustManager), null)
        }
    }

    fun caFile(context: Context): File = File(context.filesDir, CA_FILE_NAME)

    fun sslSocketFactory(): SSLSocketFactory = sslContext.socketFactory

    /**
     * Parses a stream holding one or more X.509 certificates. Handles both PEM (a
     * single certificate or a full chain) and DER. Throws if the stream is not a
     * certificate, which is how an unsuitable file picked by the user is rejected.
     */
    fun readCertificates(input: InputStream): List<X509Certificate> =
        CertificateFactory.getInstance("X.509")
            .generateCertificates(input)
            .filterIsInstance<X509Certificate>()

    /** Rebuilds the delegate chain from the platform trust store and the imported CA. */
    @Synchronized
    fun reload(context: Context) {
        val managers = mutableListOf<X509TrustManager>()
        platformTrustManager()?.let { managers.add(it) }
        importedCaTrustManager(context)?.let { managers.add(it) }
        delegates = managers
        invalidateSessions()
    }

    private fun platformTrustManager(): X509TrustManager? = trustManagerFor(null)

    private fun importedCaTrustManager(context: Context): X509TrustManager? {
        val file = caFile(context)
        if (!file.isFile) {
            return null
        }
        return try {
            val certificates = file.inputStream().use { readCertificates(it) }
            if (certificates.isEmpty()) {
                return null
            }
            val keyStore =
                KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                    load(null, null)
                    certificates.forEachIndexed { index, certificate ->
                        setCertificateEntry("clipcascade-ca-$index", certificate)
                    }
                }
            trustManagerFor(keyStore)
        } catch (e: Exception) {
            // A corrupt or unreadable file must not take the platform trust store
            // down with it, otherwise every connection would start failing.
            Log.w(TAG, "Ignoring imported CA certificate: ${e.message}")
            null
        }
    }

    private fun trustManagerFor(keyStore: KeyStore?): X509TrustManager? =
        try {
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                .apply { init(keyStore) }
                .trustManagers
                .filterIsInstance<X509TrustManager>()
                .firstOrNull()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to build trust manager: ${e.message}")
            null
        }

    /**
     * Drops cached TLS sessions so that a certificate the user just removed cannot
     * keep being accepted through session resumption.
     */
    private fun invalidateSessions() {
        try {
            val sessions = sslContext.clientSessionContext
            val ids = sessions.ids
            while (ids.hasMoreElements()) {
                sessions.getSession(ids.nextElement())?.invalidate()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to invalidate TLS sessions: ${e.message}")
        }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val managers = delegates
        if (managers.isEmpty()) {
            throw CertificateException("No trust manager available")
        }
        var firstFailure: CertificateException? = null
        for (manager in managers) {
            try {
                manager.checkServerTrusted(chain, authType)
                return
            } catch (e: CertificateException) {
                if (firstFailure == null) {
                    firstFailure = e
                }
            }
        }
        // Report the platform's complaint rather than the imported CA's, since that
        // is the one that explains the failure for an ordinary public certificate.
        throw firstFailure ?: CertificateException("Server certificate is not trusted")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val manager =
            delegates.firstOrNull() ?: throw CertificateException("No trust manager available")
        manager.checkClientTrusted(chain, authType)
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> =
        delegates.flatMap { it.acceptedIssuers.asList() }.toTypedArray()
}
