package com.helm.tv

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * The Flask server from menubar.py, reimplemented for Android.
 *
 * Bound to 127.0.0.1:5001 so the shared ui/index.html - which hardcodes
 * `const API = 'http://localhost:5001'` - runs unmodified. One UI for Mac,
 * Windows and Android.
 *
 * Security, same model as the patched desktop servers:
 *  - loopback only, so nothing else on the LAN can reach it
 *  - no CORS headers: the only client is our WebView on the same origin
 *  - Host header must be an IP literal or localhost, which stops DNS
 *    rebinding from a web page open in the tablet's browser
 *  - POSTs must be JSON and, if the browser says, from our own page, which
 *    stops cross-site form posts from a web page
 *  - /adb only ever runs the bundled adb, with an allowlisted subcommand
 */
class HelmServer(
    private val context: Context,
    private val adb: AdbManager,
    port: Int = 5001,
) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        private const val TAG = "HelmServer"
        private const val MAX_BODY = 1 shl 20 // 1 MB is far more than any request needs
        private const val JSON = "application/json"
    }

    private val tvRemote = TvRemote(context)

    override fun serve(session: IHTTPSession): Response {
        if (!hostAllowed(session.headers["host"])) {
            return json(JSONObject().put("error", "invalid Host header"), Response.Status.FORBIDDEN)
        }
        if (session.method == Method.POST) {
            postRefused(session.headers)?.let {
                return json(JSONObject().put("error", it), Response.Status.FORBIDDEN)
            }
        }
        return try {
            when {
                session.method == Method.GET && session.uri == "/" ->
                    asset(uiFor(session.headers["user-agent"]), "text/html; charset=utf-8")

                session.method == Method.GET && session.uri == "/status" -> json(
                    JSONObject()
                        .put("status", "ok")
                        .put("adb_found", adb.isAvailable)
                        .put("adb_path", "bundled")
                        .put("platform", "android")
                        .put("version", BuildConfig.VERSION_NAME),
                )

                // The UI doesn't call these, but keep parity with the desktop.
                session.method == Method.GET && session.uri == "/check-update" ->
                    json(JSONObject().put("update", false))
                session.method == Method.GET && session.uri == "/install-adb" ->
                    json(JSONObject().put("success", adb.isAvailable).put("adb_path", "bundled"))

                session.method == Method.POST && session.uri == "/adb" -> handleAdb(readJson(session))
                session.method == Method.POST && session.uri == "/pair" -> handlePair(readJson(session))
                session.method == Method.POST && session.uri == "/wake" -> handleWake(readJson(session))

                // Remote without developer options (Google's TV remote protocol). See TvRemote.kt.
                session.method == Method.GET && session.uri == "/tv-remote/status" -> json(JSONObject().put("available", true))
                session.method == Method.POST && session.uri.startsWith("/tv-remote/") -> handleTvRemote(session.uri, readJson(session))
                session.method == Method.GET && session.uri == "/scan-network" -> handleScan()

                // IR blaster. Android only: the UI asks only when it's running
                // in an Android WebView.
                session.method == Method.GET && session.uri == "/ir" -> json(IrBlaster.status(context))
                session.method == Method.POST && session.uri == "/ir" -> handleIr(readJson(session))

                session.method == Method.GET -> {
                    val rel = session.uri.trimStart('/')
                    if (rel.isEmpty() || rel.contains("..")) notFound()
                    else asset("ui/$rel", guessType(rel))
                }

                else -> notFound()
            }
        } catch (e: Exception) {
            Log.e(TAG, "request failed: ${session.method} ${session.uri}", e)
            json(JSONObject().put("output", "").put("error", e.message ?: "internal error"),
                Response.Status.INTERNAL_ERROR)
        }
    }

    // ---- routes -----------------------------------------------------------

    private fun handleAdb(body: JSONObject?): Response {
        if (body == null) return json(JSONObject().put("output", "").put("error", "invalid JSON body"),
            Response.Status.BAD_REQUEST)

        if (body.has("command")) {
            val (args, err) = adb.parseCommand(body.optString("command"))
            if (args == null) {
                return json(JSONObject().put("output", "").put("error", err), Response.Status.BAD_REQUEST)
            }
            val r = adb.exec(*args.toTypedArray())
            return json(JSONObject().put("output", r.output).put("error", r.error))
        }

        if (body.has("install_url")) {
            val r = adb.installFromUrl(body.optString("install_url"), body.optString("ip"))
            return json(JSONObject().put("output", r.output).put("error", r.error))
        }

        return json(JSONObject().put("output", "").put("error", "Unknown command"), Response.Status.BAD_REQUEST)
    }

    private fun handlePair(body: JSONObject?): Response {
        val b = body ?: JSONObject()
        val r = adb.pair(
            b.optString("pair_address"),
            b.optString("code"),
            b.optString("connect_address").ifBlank { null },
        )
        val out = JSONObject().put("success", r.success)
        if (r.success) out.put("ip", r.ip).put("model", r.model) else out.put("error", r.error)
        return json(out)
    }

    private fun handleTvRemote(uri: String, body: JSONObject?): Response {
        val b = body ?: JSONObject()
        val ip = b.optString("ip").substringBefore(':').trim()
        if (!wakeIpRe.matches(ip)) return json(JSONObject().put("success", false).put("error", "invalid ip"), Response.Status.BAD_REQUEST)
        return try {
            when (uri) {
                "/tv-remote/pair-start" -> { tvRemote.pairStart(ip); json(JSONObject().put("success", true)) }
                "/tv-remote/pair-finish" -> {
                    val dev = tvRemote.pairFinish(ip, b.optString("code"))
                    json(JSONObject().put("success", true).put("device", JSONObject(dev)))
                }
                "/tv-remote/key" -> {
                    val key = b.optInt("key", -1)
                    if (key !in 1..399) return json(JSONObject().put("success", false).put("error", "invalid key"), Response.Status.BAD_REQUEST)
                    tvRemote.press(ip, key); json(JSONObject().put("success", true))
                }
                "/tv-remote/launch" -> {
                    val url = b.optString("url").trim()
                    if (url.length > 500 || !Regex("^(https?|market)://.*").matches(url)) {
                        return json(JSONObject().put("success", false).put("error", "invalid link"), Response.Status.BAD_REQUEST)
                    }
                    tvRemote.launch(ip, url); json(JSONObject().put("success", true))
                }
                else -> json(JSONObject().put("error", "not found"), Response.Status.NOT_FOUND)
            }
        } catch (e: TvRemote.NotPaired) {
            json(JSONObject().put("success", false).put("error", if (uri.endsWith("pair-finish")) (e.message ?: "pairing failed") else "not_paired"))
        } catch (e: TvRemote.PairingError) {
            json(JSONObject().put("success", false).put("error", e.message))
        } catch (e: java.io.IOException) {
            val msg = if (uri.endsWith("pair-start")) "Couldn't reach the TV's remote service (${e.message}). Is it a Google TV or Android TV, and on the same Wi-Fi?" else "unreachable"
            json(JSONObject().put("success", false).put("error", msg))
        }
    }

    // Wake-on-LAN: see send_magic_packet in menubar.py. 6 x 0xFF, then the
    // TV's MAC 16 times, broadcast on UDP ports 9 and 7.
    private val macRe = Regex("^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$")
    private val wakeIpRe = Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")

    private fun handleWake(body: JSONObject?): Response {
        val mac = body?.optString("mac").orEmpty().trim()
        val ip = body?.optString("ip").orEmpty().substringBefore(':').trim()
        if (!macRe.matches(mac) || mac.lowercase() in setOf("00:00:00:00:00:00", "02:00:00:00:00:00", "ff:ff:ff:ff:ff:ff")) {
            return json(JSONObject().put("success", false).put("error", "mac must look like 88:42:d0:f4:48:76"), Response.Status.BAD_REQUEST)
        }
        if (ip.isNotEmpty() && !wakeIpRe.matches(ip)) {
            return json(JSONObject().put("success", false).put("error", "invalid ip"), Response.Status.BAD_REQUEST)
        }
        return try {
            val macBytes = mac.split(':').map { it.toInt(16).toByte() }.toByteArray()
            val packet = ByteArray(6) { 0xFF.toByte() } + (1..16).flatMap { macBytes.asList() }.toByteArray()
            val targets = mutableListOf("255.255.255.255")
            if (ip.isNotEmpty()) targets.add(ip.split('.').take(3).joinToString(".") + ".255")
            // Closed by hand: DatagramSocket isn't Closeable on Android 4.4.
            val sock = DatagramSocket()
            try {
                sock.broadcast = true
                for (t in targets) for (port in intArrayOf(9, 7)) {
                    try {
                        sock.send(java.net.DatagramPacket(packet, packet.size, InetAddress.getByName(t), port))
                    } catch (e: Exception) {
                        Log.w(TAG, "wake: send to $t:$port failed: ${e.message}")
                    }
                }
            } finally {
                sock.close()
            }
            json(JSONObject().put("success", true))
        } catch (e: Exception) {
            json(JSONObject().put("success", false).put("error", e.message ?: "send failed"))
        }
    }

    private fun handleIr(body: JSONObject?): Response {
        val arr = body?.optJSONArray("pattern")
        if (body == null || arr == null) {
            return json(JSONObject().put("ok", false).put("error", "invalid JSON body"), Response.Status.BAD_REQUEST)
        }
        val pattern = IntArray(arr.length()) { arr.optInt(it, 0) }
        val error = IrBlaster.transmit(context, body.optInt("frequency", 0), pattern, body.optString("timing").ifBlank { null })
        return json(if (error == null) JSONObject().put("ok", true) else JSONObject().put("ok", false).put("error", error))
    }

    private fun handleScan(): Response {
        val subnet = localSubnet()
        val arr = JSONArray()
        adb.scanNetwork(subnet).forEach { arr.put(JSONObject().put("ip", it.ip).put("model", it.model)) }
        return json(JSONObject().put("devices", arr).put("subnet", subnet))
    }

    // ---- helpers ----------------------------------------------------------

    /**
     * Two builds of the same UI (see tools/sync-ui.mjs): Chrome 51+ gets the
     * modern one; anything older - Android 4.4's WebView is Chromium 30-33
     * and can't be updated - gets the ES5 legacy build.
     */
    private fun uiFor(userAgent: String?): String {
        val chrome = userAgent?.let { Regex("Chrome/(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }
        val page = if (chrome != null && chrome >= 51) "ui/index.html" else "ui/index-legacy.html"
        Log.i(TAG, "WebView Chrome/${chrome ?: "?"} -> $page")
        return page
    }

    /**
     * DNS rebinding needs the browser to send a *hostname* that resolves to
     * us; an IP literal can't be rebound. Allow localhost and any IP literal.
     */
    private fun hostAllowed(hostHeader: String?): Boolean {
        val host = (hostHeader ?: return false).trim().let {
            if (it.startsWith("[")) it.substringAfter('[').substringBefore(']')
            else it.substringBefore(':')
        }
        if (host == "localhost") return true
        if (Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$").matches(host)) return true
        if (host.contains(':') && Regex("^[0-9a-fA-F:]+$").matches(host)) return true // IPv6 literal
        return false
    }

    /**
     * Why a POST must be refused, or null. A web page open in the device's
     * browser can send a "simple" cross-site POST (a form, or text/plain)
     * without a CORS preflight, so requests must say they are JSON - which a
     * cross-site page can only do after a preflight we never answer - and,
     * when the browser names the sending page (Origin), come from our own.
     * NanoHTTPD lower-cases header names.
     */
    private fun postRefused(headers: Map<String, String>): String? {
        val type = headers["content-type"]?.substringBefore(';')?.trim()?.lowercase()
        if (type != JSON) return "requests must be JSON"
        val origin = headers["origin"]?.trimEnd('/') ?: return null
        val port = listeningPort
        return if (origin == "http://localhost:$port" || origin == "http://127.0.0.1:$port") null
        else "cross-origin request refused"
    }

    /** Reads the request body directly; NanoHTTPD's parseBody is form-oriented. */
    private fun readJson(session: IHTTPSession): JSONObject? {
        val len = session.headers["content-length"]?.toIntOrNull() ?: return null
        if (len <= 0 || len > MAX_BODY) return null
        val buf = ByteArray(len)
        var read = 0
        val input = session.inputStream
        while (read < len) {
            val n = input.read(buf, read, len - read)
            if (n < 0) break
            read += n
        }
        return try { JSONObject(String(buf, 0, read, Charsets.UTF_8)) } catch (_: Exception) { null }
    }

    /** Our LAN address's /24, e.g. "192.168.1". */
    private fun localSubnet(): String = try {
        DatagramSocket().use { s ->
            s.connect(InetAddress.getByName("8.8.8.8"), 80)
            s.localAddress.hostAddress?.split(".")?.take(3)?.joinToString(".") ?: "192.168.1"
        }
    } catch (_: Exception) {
        "192.168.1"
    }

    private fun asset(path: String, type: String): Response = try {
        val bytes = context.assets.open(path).use { it.readBytes() }
        newFixedLengthResponse(Response.Status.OK, type, ByteArrayInputStream(bytes), bytes.size.toLong())
            .apply { addHeader("Cache-Control", "no-store") }
    } catch (_: Exception) {
        notFound()
    }

    private fun notFound(): Response =
        newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found")

    private fun json(obj: JSONObject, status: Response.Status = Response.Status.OK): Response =
        newFixedLengthResponse(status, JSON, obj.toString())

    private fun guessType(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".js") -> "application/javascript"
        path.endsWith(".json") -> JSON
        path.endsWith(".png") -> "image/png"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
        else -> "application/octet-stream"
    }
}
