package com.helm.tv

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * HTTPS that works on old Android, for APK downloads.
 *
 * Android 4.4 can't talk to most of today's HTTPS servers: TLS 1.2 is off by
 * default, it lacks the modern AES-GCM / ChaCha20 ciphers, and its root
 * certificates are years out of date (no Let's Encrypt root, for one). That's
 * also why the tablet's own browser can't open most websites.
 *
 *  - Android 8+       platform TLS and system roots, untouched
 *  - Android 5 - 7.1  platform TLS (1.2 is on), plus current Mozilla roots,
 *                     since 7.0 and older lack Let's Encrypt's ISRG Root X1
 *  - Android 4.4      Conscrypt (BoringSSL: TLS 1.2/1.3, modern ciphers)
 *                     plus current Mozilla roots
 *
 * The trust store is the device's own roots plus res/raw/cacerts.pem
 * (Mozilla's list via certifi), so nothing the device trusted is lost.
 *
 * On 4.4, certificate checking is done by the platform's own validator:
 * Conscrypt's validator needs X509ExtendedTrustManager (Android 7+), so it
 * hands the job to KitKat's. But it hands over certificates in Conscrypt's
 * object types, and KitKat's validator matches roots partly by comparing
 * public keys - across two libraries' key classes, which don't reliably
 * compare equal (notably elliptic-curve keys, as GitHub uses). Every chain
 * then looks rootless: "Trust anchor for certification path not found".
 * [PlatformChainTrustManager] re-parses the chain with the platform's own
 * CertificateFactory first, so KitKat validates exactly as designed.
 */
object Tls {
    private const val TAG = "HelmTls"
    @Volatile private var cached: SSLSocketFactory? = null

    /** null means "use the platform default". */
    fun socketFactory(context: Context): SSLSocketFactory? {
        if (Build.VERSION.SDK_INT >= 26) return null
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                .apply { init(trustStore(context)) }
            val ssl = if (Build.VERSION.SDK_INT < 21) {
                // Loaded only here, so Conscrypt's native library never
                // loads on newer devices.
                SSLContext.getInstance("TLS", org.conscrypt.Conscrypt.newProvider())
            } else {
                SSLContext.getInstance("TLS")
            }
            val managers = if (Build.VERSION.SDK_INT < 21) {
                trust.trustManagers.map { tm ->
                    if (tm is X509TrustManager) PlatformChainTrustManager(tm) else tm
                }.toTypedArray()
            } else {
                trust.trustManagers
            }
            ssl.init(null, managers, null)
            Log.i(TAG, "HTTPS via ${ssl.provider.name} (${ssl.protocol}), SDK ${Build.VERSION.SDK_INT}")
            return ssl.socketFactory.also { cached = it }
        }
    }

    private fun trustStore(context: Context): KeyStore {
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        var n = 0
        try {
            val system = KeyStore.getInstance("AndroidCAStore").apply { load(null, null) }
            for (alias in system.aliases()) {
                system.getCertificate(alias)?.let { store.setCertificateEntry("sys-${n++}", it) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not read system roots", e)
        }
        val factory = CertificateFactory.getInstance("X.509")
        context.resources.openRawResource(R.raw.cacerts).use { input ->
            for (cert in factory.generateCertificates(input)) store.setCertificateEntry("moz-${n++}", cert)
        }
        Log.i(TAG, "trust store: $n roots")
        return store
    }

    /**
     * Hands KitKat's validator certificates it created itself, and logs the
     * chain whenever validation still fails, so the reason is visible with
     * `adb logcat -s HelmTls`. It adds no leniency: the platform decides.
     */
    private class PlatformChainTrustManager(private val delegate: X509TrustManager) : X509TrustManager {
        private val factory = CertificateFactory.getInstance("X.509")

        private fun platformChain(chain: Array<X509Certificate>): Array<X509Certificate> =
            Array(chain.size) { i ->
                factory.generateCertificate(ByteArrayInputStream(chain[i].encoded)) as X509Certificate
            }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            try {
                delegate.checkServerTrusted(platformChain(chain), authType)
            } catch (e: CertificateException) {
                describe(chain, e)
                throw e
            }
        }

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            delegate.checkClientTrusted(platformChain(chain), authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers

        private fun describe(chain: Array<X509Certificate>, e: Exception) {
            val known = acceptedIssuers.map { it.subjectX500Principal }.toSet()
            Log.w(TAG, "certificate check failed: ${e.message}")
            chain.forEachIndexed { i, c ->
                Log.w(TAG, "  [$i] ${c.subjectX500Principal.name.take(90)}")
                Log.w(TAG, "      issuer ${c.issuerX500Principal.name.take(90)}" +
                    (if (c.issuerX500Principal in known) "  (root in store)" else ""))
                Log.w(TAG, "      ${c.publicKey.algorithm} key, ${c.sigAlgName}, valid ${c.notBefore} .. ${c.notAfter}")
            }
        }
    }
}
