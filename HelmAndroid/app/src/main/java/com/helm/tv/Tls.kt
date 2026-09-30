package com.helm.tv

import android.content.Context
import android.os.Build
import android.util.Log
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

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
            ssl.init(null, trust.trustManagers, null)
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
}
