package com.clipcascade

import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.websocket.WebSocketModule
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionPool
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol

/** One immutable TLS configuration shared by fetch and both WebSocket modes. */
internal object ServerTls {
    private data class Configuration(
        val serverUrl: String,
        val pem: String,
        val factory: SSLSocketFactory,
        val trustManager: X509TrustManager,
        val pool: ConnectionPool = ConnectionPool(),
    )

    @Volatile private var configuration: Configuration? = null

    fun install() {
        val customize = CustomClientBuilder { builder -> applyTo(builder) }
        NetworkingModule.setCustomClientBuilder(customize)
        WebSocketModule.setCustomClientBuilder(customize)
    }

    internal fun applyTo(builder: OkHttpClient.Builder) {
        configuration?.let {
            builder.sslSocketFactory(it.factory, it.trustManager).connectionPool(it.pool)
                // HTTP/2 can reuse one TLS connection for multiple hostnames. Force
                // a separate handshake per host to enforce the CA's hostname scope.
                .protocols(listOf(Protocol.HTTP_1_1))
        }
    }

    fun certificates(bytes: ByteArray): List<X509Certificate> {
        require(bytes.isNotEmpty() && bytes.size <= 1024 * 1024) {
            "CA bundle must be between 1 byte and 1 MiB."
        }
        val certs = CertificateFactory.getInstance("X.509")
            .generateCertificates(bytes.inputStream()).map { it as X509Certificate }
        require(certs.isNotEmpty()) { "No X.509 certificates found in the CA bundle." }
        return certs
    }

    @Synchronized fun configure(serverUrl: String, pem: String) {
        if (pem.isBlank()) {
            configuration?.pool?.evictAll()
            configuration = null
            return
        }
        if (configuration?.let { it.serverUrl == serverUrl && it.pem == pem } == true) return
        val url = requireNotNull(serverUrl.toHttpUrlOrNull()) { "Invalid server URL." }
        // HTTP/WS do not use TLS; keep the bundle available for HTTPS/WSS.
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
        certificates(pem.toByteArray(Charsets.UTF_8)).forEachIndexed { index, cert ->
            store.setCertificateEntry("ca-$index", cert)
        }
        val system = trustManager(null)
        val custom = trustManager(store)
        val combined = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> =
                system.acceptedIssuers + custom.acceptedIssuers
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                try {
                    system.checkServerTrusted(chain, authType)
                } catch (e: CertificateException) {
                    custom.checkServerTrusted(chain, authType)
                }
            }
        }
        val systemFactory = context(system).socketFactory
        val customFactory = context(combined).socketFactory
        val next = Configuration(serverUrl, pem,
            HostSocketFactory(url.host, systemFactory, customFactory), combined)
        configuration?.pool?.evictAll()
        configuration = next
    }

    private fun trustManager(store: KeyStore?): X509TrustManager =
        TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(store)
        }.trustManagers.filterIsInstance<X509TrustManager>().single()

    private fun context(manager: X509TrustManager): SSLContext =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), SecureRandom()) }

    // OkHttp supplies the URL hostname when layering TLS over its connected socket.
    // Select the trust context here so redirects and unrelated hosts cannot use the
    // imported CA. Keep OkHttp's default hostname verifier unchanged.
    private class HostSocketFactory(
        private val host: String,
        private val system: SSLSocketFactory,
        private val custom: SSLSocketFactory,
    ) : SSLSocketFactory() {
        private fun factory(name: String) =
            if (name.removePrefix("[").removeSuffix("]").equals(host, ignoreCase = true)) custom else system
        override fun getDefaultCipherSuites(): Array<String> = system.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = system.supportedCipherSuites
        override fun createSocket(): Socket = system.createSocket()
        override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
            factory(host).createSocket(s, host, port, autoClose)
        override fun createSocket(host: String, port: Int): Socket = factory(host).createSocket(host, port)
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
            factory(host).createSocket(host, port, local, localPort)
        override fun createSocket(address: InetAddress, port: Int): Socket = system.createSocket(address, port)
        override fun createSocket(address: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket =
            system.createSocket(address, port, local, localPort)
    }
}
