package com.helm.tv

import android.content.Context
import android.util.Log
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Drives a real adb binary bundled inside the APK.
 *
 * Why a bundled binary rather than a Kotlin ADB library: libraries such as
 * dadb speak the classic port-5555 handshake but not `adb pair`, the
 * TLS + SPAKE2 pairing that Android 11+ TVs require for wireless debugging.
 * A real adb has it built in.
 *
 * Why it's named libadb.so: Android only extracts files matching lib*.so into
 * nativeLibraryDir, and that is the one app-private directory that is always
 * executable (Android 10+ forbids exec from the app data directory).
 *
 * The bundled binaries are fully static (no shared-library dependencies), so
 * they don't care what the host OS version ships.
 */
class AdbManager(private val context: Context) {

    companion object {
        private const val TAG = "HelmAdb"
        private const val DEFAULT_TIMEOUT_SEC = 30L

        /** Non-default port, so we never collide with any other adb server. */
        private const val ADB_SERVER_PORT = "5039"

        /** Mirrors the allowlist in menubar.py / menubar_windows.py. */
        val ALLOWED_SUBCOMMANDS = setOf(
            "connect", "disconnect", "reconnect", "devices", "shell", "install",
            "uninstall", "pair", "get-state", "start-server", "kill-server",
            "wait-for-device", "forward", "reverse", "push", "pull", "reboot",
            "root", "unroot", "tcpip", "usb", "version",
        )
        private val FLAGS_WITH_VALUE = setOf("-s", "-P", "-H", "-L", "-t")
    }

    private val adbBinary: File
        get() = File(context.applicationInfo.nativeLibraryDir, "libadb.so")

    /** adb keeps its RSA identity in $HOME/.android/adbkey. */
    private val adbHome: File by lazy {
        File(context.filesDir, "adbhome").apply { mkdirs() }
    }

    val isAvailable: Boolean
        get() = adbBinary.exists()

    data class Result(val output: String, val error: String, val exitCode: Int) {
        val combined: String get() = (output + "\n" + error).trim()
    }

    /**
     * Validate a command string from the UI ("adb -s 1.2.3.4:5555 shell ...")
     * and return the argv that follows "adb". Same rules as the desktop app.
     */
    fun parseCommand(raw: String): Pair<List<String>?, String?> {
        val cmd = raw.trim()
        if (!cmd.startsWith("adb ")) return null to "only adb commands are allowed"
        val args = cmd.substring(4).trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (args.isEmpty()) return null to "empty adb command"
        var i = 0
        while (i < args.size && args[i].startsWith("-")) {
            i += if (args[i] in FLAGS_WITH_VALUE) 2 else 1
        }
        if (i >= args.size) return null to "no adb subcommand given"
        if (args[i] !in ALLOWED_SUBCOMMANDS) return null to "adb subcommand not allowed: ${args[i]}"
        return args to null
    }

    /**
     * Run adb with an argument list. There is no shell: nothing is split,
     * globbed or expanded, and the program is always the bundled adb.
     *
     * Deliberately avoids Process.waitFor(timeout, unit), destroyForcibly()
     * and isAlive() - all three were only added in Android 8.0 and throw
     * NoSuchMethodError on the Android 7 tablet this targets. Both output
     * streams are drained on their own threads so a full stderr pipe can't
     * deadlock us, and a watchdog enforces the timeout.
     */
    fun exec(vararg args: String, timeoutSec: Long = DEFAULT_TIMEOUT_SEC): Result {
        if (!isAvailable) {
            return Result("", "adb is not bundled in this build", -1)
        }
        val proc: Process = try {
            ProcessBuilder(listOf(adbBinary.absolutePath) + args).apply {
                environment().apply {
                    put("HOME", adbHome.absolutePath)
                    put("TMPDIR", context.cacheDir.absolutePath)
                    put("ANDROID_ADB_SERVER_PORT", ADB_SERVER_PORT)
                }
                directory(adbHome)
            }.start()
        } catch (e: Exception) {
            Log.e(TAG, "could not start adb", e)
            return Result("", "could not start adb: ${e.message}", -1)
        }

        val out = StringBuilder()
        val err = StringBuilder()
        val outThread = drain(proc.inputStream, out)
        val errThread = drain(proc.errorStream, err)

        val timedOut = AtomicBoolean(false)
        val watchdog = Thread {
            try {
                Thread.sleep(timeoutSec * 1000)
                timedOut.set(true)
                proc.destroy()
            } catch (_: InterruptedException) {
                // finished in time
            }
        }.apply { isDaemon = true; start() }

        val code = try {
            proc.waitFor()
        } catch (e: InterruptedException) {
            proc.destroy()
            -1
        } finally {
            watchdog.interrupt()
        }
        outThread.join(2000)
        errThread.join(2000)

        return if (timedOut.get()) {
            Result(out.toString(), "Timed out after ${timeoutSec}s", -2)
        } else {
            Result(out.toString(), err.toString(), code)
        }
    }

    private fun drain(stream: InputStream, into: StringBuilder): Thread =
        Thread {
            try {
                stream.bufferedReader().use { r ->
                    val buf = CharArray(4096)
                    while (true) {
                        val n = r.read(buf)
                        if (n < 0) break
                        synchronized(into) { into.append(buf, 0, n) }
                    }
                }
            } catch (_: Exception) {
                // stream closed when the process was destroyed
            }
        }.apply { isDaemon = true; start() }

    fun startServer(): Result = exec("start-server", timeoutSec = 20)

    fun killServer(): Result = exec("kill-server", timeoutSec = 10)

    fun version(): Result = exec("version", timeoutSec = 10)

    // ---- pairing ---------------------------------------------------------

    data class PairResult(
        val success: Boolean,
        val ip: String? = null,
        val model: String? = null,
        val error: String? = null,
    )

    private val pairAddressRe = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}:[0-9]{1,5}$")
    private val pairCodeRe = Regex("^[0-9]{6}$")

    /**
     * Android 11+ pairing, then connect. Mirrors the desktop /pair route,
     * including its retry: pairing sometimes fails with "protocol fault
     * (couldn't read status message)" until the adb server is restarted.
     *
     * [connectAddress] is the ip:port from the main Wireless debugging screen.
     * It is a different random port from the pairing port. When omitted we
     * fall back to 5555, which is what the desktop app does.
     */
    fun pair(pairAddress: String, code: String, connectAddress: String? = null): PairResult {
        val addr = pairAddress.trim()
        val pin = code.trim()
        if (!pairAddressRe.matches(addr)) {
            return PairResult(false, error = "Pairing address should look like 192.168.1.45:37829")
        }
        if (!pairCodeRe.matches(pin)) {
            return PairResult(false, error = "The pairing code is the 6 digits shown on the TV")
        }
        val ip = addr.substringBefore(':')

        var out = exec("pair", addr, pin, timeoutSec = 20).combined
        if (out.needsServerRestart()) {
            Log.w(TAG, "pair failed, restarting adb server and retrying: $out")
            killServer()
            Thread.sleep(500)
            startServer()
            Thread.sleep(500)
            out = exec("pair", addr, pin, timeoutSec = 20).combined
        }
        if (!out.contains("Successfully paired", ignoreCase = true)) {
            return PairResult(false, error = out.ifBlank { "Pairing failed - get a fresh code from the TV" })
        }

        Thread.sleep(1000)
        val target = connectAddress?.trim()?.takeIf { pairAddressRe.matches(it) } ?: "$ip:5555"
        val conn = exec("connect", target, timeoutSec = 15).combined
        if (!conn.contains("connected to", ignoreCase = true) || conn.contains("failed", ignoreCase = true)) {
            return PairResult(
                false,
                error = "Paired, but could not connect to $target. On the TV, use the IP and port " +
                    "shown on the main Wireless debugging screen (not the pairing port). ($conn)",
            )
        }
        val model = exec("-s", target, "shell", "getprop", "ro.product.model", timeoutSec = 10)
            .output.trim().ifBlank { "Unknown device" }
        return PairResult(true, ip = ip, model = model)
    }

    private fun String.needsServerRestart(): Boolean {
        val s = lowercase()
        return "protocol fault" in s || "couldn't read status message" in s ||
            "cannot connect to daemon" in s || "daemon not running" in s
    }

    // ---- network scan ----------------------------------------------------

    data class FoundDevice(val ip: String, val model: String)

    /**
     * Find devices with port 5555 open on our /24.
     *
     * Not a 254-way adb fan-out like the desktop version: on a phone that is
     * 254 process spawns. Probe the port with plain sockets first (cheap), and
     * only run adb against hosts that answered.
     */
    fun scanNetwork(subnet: String): List<FoundDevice> {
        val alive = Collections.synchronizedList(mutableListOf<String>())
        // 32 threads is plenty and stays gentle on a 1 GB device.
        val pool = Executors.newFixedThreadPool(32)
        try {
            val tasks = (1..254).map { host ->
                Callable<Unit> {
                    val ip = "$subnet.$host"
                    try {
                        Socket().use { s ->
                            s.connect(InetSocketAddress(ip, 5555), 400)
                            alive.add(ip)
                        }
                    } catch (_: Exception) {
                        // closed or unreachable - the common case
                    }
                }
            }
            pool.invokeAll(tasks, 30, TimeUnit.SECONDS)
        } finally {
            pool.shutdownNow()
        }

        return alive.sorted().mapNotNull { ip ->
            val out = exec("connect", "$ip:5555", timeoutSec = 6).combined
            if (!out.contains("connected to", ignoreCase = true) || out.contains("failed", ignoreCase = true)) {
                return@mapNotNull null
            }
            val model = exec("-s", "$ip:5555", "shell", "getprop", "ro.product.model", timeoutSec = 6)
                .output.trim().ifBlank { "Unknown device" }
            FoundDevice(ip, model)
        }
    }

    // ---- install from URL ------------------------------------------------

    private val ipRe = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")

    /**
     * Download an APK then `adb install -r` it, like the desktop route.
     * Streams to disk rather than memory: the Tab 3 has 1 GB of RAM and
     * Kodi alone is ~80 MB. HTTPS goes through [Tls], which is what makes
     * downloads work at all on Android 4.4.
     */
    fun installFromUrl(url: String, ipRaw: String): Result {
        val ip = ipRaw.substringBefore(':').trim()
        if (!ipRe.matches(ip)) return Result("", "invalid ip", -1)
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            return Result("", "invalid download url", -1)
        }
        val tmp = File(context.cacheDir, "download-${System.currentTimeMillis()}.apk")
        return try {
            var current = URL(url)
            var conn: HttpURLConnection
            var hops = 0
            // Follow redirects manually: HttpURLConnection won't follow an
            // http -> https hop on its own, and mirror hosts do exactly that.
            while (true) {
                conn = (current.openConnection() as HttpURLConnection).apply {
                    if (this is javax.net.ssl.HttpsURLConnection) {
                        Tls.socketFactory(context)?.let { sslSocketFactory = it }
                    }
                    instanceFollowRedirects = false
                    connectTimeout = 30_000
                    readTimeout = 120_000
                    setRequestProperty("User-Agent", "Helm/${BuildConfig.VERSION_NAME} (Android)")
                }
                val code = conn.responseCode
                if (code in 300..399 && hops < 10) {
                    val loc = conn.getHeaderField("Location") ?: break
                    current = URL(current, loc)
                    conn.disconnect()
                    hops++
                    continue
                }
                if (code !in 200..299) {
                    return Result("", "download failed: HTTP $code", -1)
                }
                break
            }
            conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it, 64 * 1024) } }
            exec("-s", "$ip:5555", "install", "-r", tmp.absolutePath, timeoutSec = 300)
        } catch (e: Exception) {
            Log.e(TAG, "install from url failed", e)
            Result("", "download failed: ${e.message}", -1)
        } finally {
            tmp.delete()
        }
    }
}
