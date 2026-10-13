package com.helm.tv

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Google TV / Android TV remote control without developer options: the same
 * protocol as Google's TV remote, and the Kotlin twin of atvremote.py in the
 * desktop app (see that file for the protocol notes). The TV's built-in
 * remote service listens on 6467 for pairing and 6466 for control, over TLS
 * with a client certificate. Pair once with the code the TV shows; after that
 * keys go over one open connection, much faster than an adb command per key.
 */
class TvRemote(private val context: Context) {
    companion object {
        private const val TAG = "HelmTvRemote"
        private const val PAIR_PORT = 6467
        private const val REMOTE_PORT = 6466
        private const val OK = 200
        // ping, key, ime, power, volume, app link
        private const val FEATURES = (1 shl 0) or (1 shl 1) or (1 shl 2) or (1 shl 5) or (1 shl 6) or (1 shl 9)
        private val PASS = "helm".toCharArray()
    }

    class PairingError(msg: String) : Exception(msg)
    class NotPaired(msg: String) : Exception(msg)
    class NoTextBox(msg: String) : Exception(msg)

    // ------------------------------------------------------------ protobuf
    private fun varint(n0: Long): ByteArray {
        var n = n0
        val out = ByteArrayOutputStream()
        while (true) {
            val b = (n and 0x7F).toInt()
            n = n ushr 7
            if (n != 0L) out.write(b or 0x80) else { out.write(b); return out.toByteArray() }
        }
    }

    /** Encode (field, value) pairs: Int/Long/Boolean -> varint, String/ByteArray -> bytes. */
    private fun pb(vararg fields: Pair<Int, Any?>): ByteArray {
        val out = ByteArrayOutputStream()
        for ((num, v) in fields) {
            when (v) {
                null -> {}
                is Boolean -> { out.write(varint((num shl 3).toLong())); out.write(varint(if (v) 1 else 0)) }
                is Int -> { out.write(varint((num shl 3).toLong())); out.write(varint(v.toLong() and 0xFFFFFFFFL)) }
                is Long -> { out.write(varint((num shl 3).toLong())); out.write(varint(v)) }
                is String -> { val b = v.toByteArray(Charsets.UTF_8); out.write(varint(((num shl 3) or 2).toLong())); out.write(varint(b.size.toLong())); out.write(b) }
                is ByteArray -> { out.write(varint(((num shl 3) or 2).toLong())); out.write(varint(v.size.toLong())); out.write(v) }
            }
        }
        return out.toByteArray()
    }

    /** One message level: field number -> values (Long for varints, ByteArray for the rest). */
    private fun parse(buf: ByteArray): Map<Int, List<Any>> {
        val fields = HashMap<Int, MutableList<Any>>()
        var pos = 0
        fun readVarint(): Long {
            var shift = 0; var result = 0L
            while (true) {
                if (pos >= buf.size) throw IllegalArgumentException("truncated")
                val b = buf[pos++].toInt() and 0xFF
                result = result or ((b and 0x7F).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
            }
        }
        while (pos < buf.size) {
            val key = readVarint()
            val num = (key ushr 3).toInt()
            val v: Any = when ((key and 7).toInt()) {
                0 -> readVarint()
                2 -> { val ln = readVarint().toInt(); val b = buf.copyOfRange(pos, pos + ln); pos += ln; b }
                1 -> { val b = buf.copyOfRange(pos, pos + 8); pos += 8; b }
                5 -> { val b = buf.copyOfRange(pos, pos + 4); pos += 4; b }
                else -> throw IllegalArgumentException("bad wire type")
            }
            fields.getOrPut(num) { ArrayList() }.add(v)
        }
        return fields
    }

    private fun Map<Int, List<Any>>.long(n: Int, def: Long = 0): Long = (this[n]?.firstOrNull() as? Long) ?: def
    private fun Map<Int, List<Any>>.bytes(n: Int): ByteArray? = this[n]?.firstOrNull() as? ByteArray

    private fun send(out: OutputStream, msg: ByteArray) {
        out.write(varint(msg.size.toLong()) + msg)
        out.flush()
    }

    private fun receive(input: InputStream): ByteArray {
        var len = 0L; var shift = 0
        while (true) {
            val b = input.read()
            if (b < 0) throw java.io.IOException("the TV closed the connection")
            len = len or ((b and 0x7F).toLong() shl shift)
            if (b and 0x80 == 0) break
            shift += 7
        }
        val buf = ByteArray(len.toInt())
        var off = 0
        while (off < buf.size) {
            val r = input.read(buf, off, buf.size - off)
            if (r < 0) throw java.io.IOException("the TV closed the connection")
            off += r
        }
        return buf
    }

    // ------------------------------------------------------------ identity
    private class Identity(val key: PrivateKey, val cert: X509Certificate)
    @Volatile private var identity: Identity? = null

    private fun tlv(tag: Int, content: ByteArray): ByteArray {
        val n = content.size
        val len = if (n < 0x80) byteArrayOf(n.toByte()) else {
            val b = BigInteger.valueOf(n.toLong()).toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            byteArrayOf((0x80 or b.size).toByte()) + b
        }
        return byteArrayOf(tag.toByte()) + len + content
    }
    private fun seq(vararg parts: ByteArray) = tlv(0x30, parts.fold(ByteArray(0)) { a, b -> a + b })
    private fun derInt(n: BigInteger) = tlv(0x02, n.toByteArray())
    private fun oid(dotted: String): ByteArray {
        val nums = dotted.split('.').map { it.toLong() }
        val out = ByteArrayOutputStream()
        out.write((40 * nums[0] + nums[1]).toInt())
        for (n0 in nums.drop(2)) {
            var n = n0
            val enc = ArrayList<Int>()
            enc.add((n and 0x7F).toInt()); n = n ushr 7
            while (n != 0L) { enc.add(0x80 or (n and 0x7F).toInt()); n = n ushr 7 }
            enc.reversed().forEach { out.write(it) }
        }
        return tlv(0x06, out.toByteArray())
    }
    private fun utcTime(d: Date): ByteArray {
        val f = SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return tlv(0x17, f.format(d).toByteArray(Charsets.US_ASCII))
    }

    /** Helm's own self-signed certificate + RSA key, made once and kept. */
    private fun identity(): Identity {
        identity?.let { return it }
        synchronized(this) {
            identity?.let { return it }
            val dir = File(context.filesDir, "tvremote").apply { mkdirs() }
            val keyFile = File(dir, "key.pk8")
            val certFile = File(dir, "cert.der")
            if (!keyFile.exists() || !certFile.exists()) {
                val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048, SecureRandom()) }.generateKeyPair()
                val pub = kp.public as RSAPublicKey
                val sha256Rsa = seq(oid("1.2.840.113549.1.1.11"), byteArrayOf(0x05, 0x00))
                val name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0C, "Helm".toByteArray()))))
                val now = System.currentTimeMillis()
                val spki = seq(seq(oid("1.2.840.113549.1.1.1"), byteArrayOf(0x05, 0x00)),
                    tlv(0x03, byteArrayOf(0) + seq(derInt(pub.modulus), derInt(pub.publicExponent))))
                val tbs = seq(tlv(0xA0, derInt(BigInteger.valueOf(2))),
                    derInt(BigInteger(63, SecureRandom()).setBit(0)),
                    sha256Rsa, name,
                    seq(utcTime(Date(now - 86_400_000L)), utcTime(Date(now + 20L * 365 * 86_400_000L))),
                    name, spki)
                val sig = Signature.getInstance("SHA256withRSA").apply { initSign(kp.private); update(tbs) }.sign()
                val der = seq(tbs, sha256Rsa, tlv(0x03, byteArrayOf(0) + sig))
                keyFile.writeBytes(kp.private.encoded)
                certFile.writeBytes(der)
            }
            val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyFile.readBytes()))
            val cert = CertificateFactory.getInstance("X.509")
                .generateCertificate(certFile.inputStream()) as X509Certificate
            return Identity(key, cert).also { identity = it }
        }
    }

    // ------------------------------------------------------------ TLS
    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}   // the TV's certificate is self-signed
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    @Volatile private var sslContext: SSLContext? = null
    private fun ssl(): SSLContext {
        sslContext?.let { return it }
        synchronized(this) {
            sslContext?.let { return it }
            val id = identity()
            val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null, null)
                setKeyEntry("helm", id.key, PASS, arrayOf(id.cert))
            }
            val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, PASS) }
            // Android 4.4's own TLS is too old for the TV; Conscrypt (bundled) speaks TLS 1.2/1.3.
            val ctx = if (Build.VERSION.SDK_INT < 21) SSLContext.getInstance("TLS", org.conscrypt.Conscrypt.newProvider())
                      else SSLContext.getInstance("TLS")
            ctx.init(kmf.keyManagers, arrayOf<TrustManager>(trustAll), SecureRandom())
            return ctx.also { sslContext = it }
        }
    }

    private fun connect(ip: String, port: Int): SSLSocket {
        val raw = Socket()
        raw.connect(InetSocketAddress(ip, port), 8000)
        raw.soTimeout = 10_000
        val s = ssl().socketFactory.createSocket(raw, ip, port, true) as SSLSocket
        s.startHandshake()
        return s
    }

    private fun minimal(n: BigInteger): ByteArray = n.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()

    // ------------------------------------------------------------ pairing
    private val pairings = HashMap<String, SSLSocket>()

    private fun outer(field: Int, body: ByteArray) = pb(1 to 2, 2 to OK, field to body)
    private val hex6 = pb(1 to 3, 2 to 6)   // Encoding: hexadecimal, 6 symbols

    private fun expect(s: SSLSocket, field: Int) {
        val msg = parse(receive(s.inputStream))
        val status = msg.long(2, OK.toLong()).toInt()
        if (status != OK) throw PairingError(when (status) {
            402 -> "that code doesn't match the one on the TV"
            401 -> "the TV rejected the pairing settings"
            else -> "the TV reported an error ($status)"
        })
        if (!msg.containsKey(field)) throw PairingError("unexpected reply from the TV")
    }

    fun pairStart(ip: String) {
        synchronized(pairings) { pairings.remove(ip)?.let { closeQuietly(it) } }
        val s = connect(ip, PAIR_PORT)
        try {
            send(s.outputStream, outer(10, pb(1 to "atvremote", 2 to "Helm")))   // pairing_request
            expect(s, 11)
            send(s.outputStream, outer(20, pb(1 to hex6, 3 to 1)))               // options
            expect(s, 20)
            send(s.outputStream, outer(30, pb(1 to hex6, 2 to 1)))               // configuration
            expect(s, 31)                                                        // code is on screen
        } catch (e: Exception) {
            closeQuietly(s); throw e
        }
        s.soTimeout = 0
        synchronized(pairings) { pairings[ip] = s }
    }

    fun pairFinish(ip: String, code0: String): Map<String, String> {
        val code = code0.trim().uppercase(Locale.US)
        if (!Regex("^[0-9A-F]{6}$").matches(code)) throw PairingError("the code is 6 characters: numbers and the letters A to F")
        val s = synchronized(pairings) { pairings.remove(ip) } ?: throw PairingError("start pairing again: the code on the TV has expired")
        try {
            s.soTimeout = 10_000
            val client = identity().cert.publicKey as RSAPublicKey
            val server = s.session.peerCertificates[0].publicKey as RSAPublicKey
            val md = MessageDigest.getInstance("SHA-256")
            md.update(minimal(client.modulus)); md.update(minimal(client.publicExponent))
            md.update(minimal(server.modulus)); md.update(minimal(server.publicExponent))
            md.update(BigInteger(code.substring(2), 16).toByteArray().let { b ->
                // exactly 2 bytes for the last 4 hex digits
                val m = b.dropWhile { it == 0.toByte() }.toByteArray(); ByteArray(2 - m.size) + m })
            val digest = md.digest()
            if ((digest[0].toInt() and 0xFF) != code.substring(0, 2).toInt(16)) throw PairingError("that code doesn't match the one on the TV")
            send(s.outputStream, outer(40, pb(1 to digest)))                     // secret
            expect(s, 41)                                                        // paired
            Log.i(TAG, "paired with $ip")
        } finally {
            closeQuietly(s)
        }
        return try {
            remote(ip).device
        } catch (e: Exception) {
            Log.w(TAG, "paired with $ip, but the remote connection failed", e)
            throw e
        }
    }

    // ------------------------------------------------------------ remote
    inner class Remote(val ip: String) {
        private val sock: SSLSocket = connect(ip, REMOTE_PORT)
        private val lock = Object()
        @Volatile var closed = false
        @Volatile var device: Map<String, String> = emptyMap()
        @Volatile var app: String? = null                 // app on screen, from IME messages
        @Volatile var volume: IntArray? = null            // level, max, muted(0/1)
        @Volatile var ime: LongArray? = null              // ime_counter, field_counter while a text box has focus
        private val ready = java.util.concurrent.CountDownLatch(1)

        init {
            Log.i(TAG, "remote: connected to $ip:$REMOTE_PORT (${sock.session.protocol}, ${sock.session.cipherSuite})")
            sock.soTimeout = 0
            Thread({ reader() }, "HelmTvRemote-$ip").apply { isDaemon = true; start() }
            if (!ready.await(10, java.util.concurrent.TimeUnit.SECONDS)) { close(); throw java.io.IOException("the TV didn't finish setting up the remote") }
            if (closed) throw NotPaired("the TV closed the remote connection")
        }

        private fun write(msg: ByteArray) = synchronized(lock) { send(sock.outputStream, msg) }

        private fun reader() {
            try {
                while (!closed) {
                    val msg = parse(receive(sock.inputStream))
                    Log.d(TAG, "remote: message fields ${msg.keys}")
                    when {
                        msg.containsKey(1) -> {                                   // remote_configure
                            val cfg = parse(msg.bytes(1)!!)
                            val info = parse(cfg.bytes(2) ?: ByteArray(0))
                            device = mapOf("model" to String(info.bytes(1) ?: ByteArray(0)), "vendor" to String(info.bytes(2) ?: ByteArray(0)))
                            val feats = (cfg.long(1, FEATURES.toLong()).toInt()) and FEATURES
                            write(pb(1 to pb(1 to feats, 2 to pb(3 to 1, 4 to "1", 5 to "atvremote", 6 to "1.0.0"))))
                        }
                        msg.containsKey(2) -> write(pb(2 to pb(1 to FEATURES)))        // set_active
                        msg.containsKey(8) -> write(pb(9 to pb(1 to parse(msg.bytes(8)!!).long(1))))   // ping -> pong
                        msg.containsKey(20) -> {                                         // ime_key_inject: app on screen
                            val info = parse(parse(msg.bytes(20)!!).bytes(1) ?: ByteArray(0))
                            info.bytes(12)?.let { app = String(it) }
                        }
                        msg.containsKey(21) -> {                                         // ime_batch_edit: text box focused
                            val be = parse(msg.bytes(21)!!)
                            ime = longArrayOf(be.long(1), be.long(2))
                        }
                        msg.containsKey(50) -> {                                         // volume level
                            val v = parse(msg.bytes(50)!!)
                            volume = intArrayOf(v.long(7).toInt(), v.long(6).toInt(), v.long(8).toInt())
                        }
                        msg.containsKey(40) -> ready.countDown()                        // remote_start
                    }
                }
            } catch (e: Exception) {
                Log.i(TAG, "remote connection to $ip ended: ${e.message}")
            } finally {
                closed = true
                ready.countDown()
            }
        }

        fun press(keycode: Int) {
            if (closed) throw java.io.IOException("not connected")
            write(pb(10 to pb(1 to keycode, 2 to 3)))     // key_inject, SHORT
        }

        fun typeText(text: String) {
            if (closed) throw java.io.IOException("not connected")
            val counters = ime ?: throw NoTextBox("no text box is open on the TV")
            val at = text.length - 1
            val edit = pb(1 to 1, 2 to pb(1 to at, 2 to at, 3 to text))
            write(pb(21 to pb(1 to counters[0], 2 to counters[1], 3 to edit)))
        }

        fun launch(url: String) {
            if (closed) throw java.io.IOException("not connected")
            write(pb(90 to pb(1 to url)))
        }

        fun close() { closed = true; closeQuietly(sock) }
    }

    private val remotes = HashMap<String, Remote>()

    private fun remote(ip: String): Remote {
        synchronized(remotes) {
            remotes[ip]?.let { if (!it.closed) return it }
            val r = try { Remote(ip) } catch (e: javax.net.ssl.SSLException) { throw NotPaired(e.message ?: "not paired") }
            remotes[ip] = r
            return r
        }
    }

    fun press(ip: String, keycode: Int) {
        for (attempt in 0..1) {
            val r = remote(ip)
            try { r.press(keycode); return } catch (e: java.io.IOException) { r.close(); if (attempt == 1) throw e }
        }
    }

    fun typeText(ip: String, text: String) = remote(ip).typeText(text)

    fun state(ip: String): org.json.JSONObject {
        val r = remote(ip)
        val o = org.json.JSONObject().put("success", true).put("typing", r.ime != null)
            .put("device", org.json.JSONObject(r.device))
        r.app?.let { o.put("app", it) }
        r.volume?.let { o.put("volume", org.json.JSONObject().put("level", it[0]).put("max", it[1]).put("muted", it[2] != 0)) }
        return o
    }

    fun launch(ip: String, url: String) {
        for (attempt in 0..1) {
            val r = remote(ip)
            try { r.launch(url); return } catch (e: java.io.IOException) { r.close(); if (attempt == 1) throw e }
        }
    }

    private fun closeQuietly(s: Socket) { try { s.close() } catch (e: Exception) {} }
}
