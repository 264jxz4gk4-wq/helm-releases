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

    override fun serve(session: IHTTPSession): Response {
        if (!hostAllowed(session.headers["host"])) {
            return json(JSONObject().put("error", "invalid Host header"), Response.Status.FORBIDDEN)
        }
        return try {
            when {
                session.method == Method.GET && session.uri == "/" ->
                    asset("ui/index.html", "text/html; charset=utf-8")

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
                session.method == Method.GET && session.uri == "/scan-network" -> handleScan()

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

    private fun handleScan(): Response {
        val subnet = localSubnet()
        val arr = JSONArray()
        adb.scanNetwork(subnet).forEach { arr.put(JSONObject().put("ip", it.ip).put("model", it.model)) }
        return json(JSONObject().put("devices", arr).put("subnet", subnet))
    }

    // ---- helpers ----------------------------------------------------------

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
