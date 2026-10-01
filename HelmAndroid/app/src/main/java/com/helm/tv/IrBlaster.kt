package com.helm.tv

import android.content.Context
import android.hardware.ConsumerIrManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The device's infrared transmitter, if it has one (e.g. the Galaxy Tab 3
 * and some Xiaomi phones). Lets the Remote page work a TV over IR, including
 * turning it on, which adb can't do once the TV is off.
 *
 * The UI encodes each button (ui/index.html, HelmIR) into a carrier
 * frequency and a mark/space pattern in microseconds; this only checks the
 * request and hands it to ConsumerIrManager.
 */
object IrBlaster {
    private const val TAG = "HelmIr"
    private const val MAX_TOTAL_US = 2_000_000L // ConsumerIrService's own limit
    private const val MAX_ENTRIES = 1024

    private fun manager(context: Context): ConsumerIrManager? = try {
        context.getSystemService(Context.CONSUMER_IR_SERVICE) as? ConsumerIrManager
    } catch (e: Exception) {
        null
    }

    /**
     * Android 4.4.0 - 4.4.2 read the pattern as counts of carrier cycles;
     * 4.4.3 changed it to microseconds. Some vendor IR drivers kept the old
     * behaviour, so the UI can also ask for either explicitly.
     */
    private fun platformUsesCycles(): Boolean {
        if (Build.VERSION.SDK_INT != 19) return false
        val parts = Build.VERSION.RELEASE.split('.')
        val patch = parts.getOrNull(2)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0
        return parts.getOrNull(0) == "4" && parts.getOrNull(1) == "4" && patch < 3
    }

    fun status(context: Context): JSONObject {
        val ir = manager(context)
        val available = try { ir?.hasIrEmitter() == true } catch (e: Exception) { false }
        val carriers = JSONArray()
        if (available) {
            try {
                ir!!.carrierFrequencies?.forEach {
                    carriers.put(JSONArray().put(it.minFrequency).put(it.maxFrequency))
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not read carrier frequencies", e)
            }
        }
        return JSONObject()
            .put("available", available)
            .put("carriers", carriers)
            .put("timing", if (platformUsesCycles()) "cycles" else "us")
    }

    /** Returns null on success, otherwise a reason a person can read. */
    fun transmit(context: Context, frequency: Int, pattern: IntArray, timing: String?): String? {
        val ir = manager(context)
        if (ir == null || !ir.hasIrEmitter()) return "This device has no IR blaster"
        if (frequency !in 15_000..100_000) return "Carrier frequency out of range"
        if (pattern.isEmpty() || pattern.size > MAX_ENTRIES) return "Bad IR pattern"
        var total = 0L
        for (v in pattern) {
            if (v !in 1..500_000) return "Bad IR pattern"
            total += v
        }
        if (total > MAX_TOTAL_US) return "IR pattern too long"

        val cycles = when (timing) {
            "cycles" -> true
            "us" -> false
            else -> platformUsesCycles()
        }
        val send = if (cycles) {
            // Double first: µs × Hz overflows an Int for gaps over ~56 ms at 38 kHz.
            IntArray(pattern.size) { i -> Math.max(1L, Math.round(pattern[i].toDouble() * frequency / 1_000_000.0)).toInt() }
        } else {
            pattern
        }
        return try {
            ir.transmit(frequency, send)
            null
        } catch (e: Exception) {
            Log.w(TAG, "transmit failed ($frequency Hz, ${pattern.size} entries, cycles=$cycles)", e)
            "IR send failed: ${e.message ?: e.javaClass.simpleName}"
        }
    }
}
