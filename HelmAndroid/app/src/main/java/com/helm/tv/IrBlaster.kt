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
        val status = JSONObject()
            .put("available", available)
            .put("carriers", carriers)
            .put("timing", if (platformUsesCycles()) "cycles" else "us")
        if (available && Build.VERSION.SDK_INT < 26 && IrDriverCheck.secIrMissing()) {
            // Android says there's an emitter, but nothing will come out of it.
            status.put("problem", "no-driver")
        }
        return status
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

/**
 * Spots one way an IR blaster can be reported but dead: Samsung-style IR
 * drivers (consumerir.*.so, as in CyanogenMod builds for Samsung devices)
 * write each code to /sys/class/sec/sec_ir/ir_send, and some kernels - the
 * CyanogenMod 11 kernel on the Galaxy Tab 3 7.0, for one - don't have that
 * driver. The HAL then reports success for every code and nothing is sent.
 *
 * Only says "missing" when it can see for itself: the HAL file names that
 * path, and /sys/class/sec is readable and has no sec_ir in it. Anything it
 * can't read counts as "fine", so a working device is never flagged. Only
 * used before Android 8, when IR drivers were plain .so files like this.
 *
 * No Android classes here, so it can be tested on a plain JVM.
 */
object IrDriverCheck {
    private const val SEC_IR_SEND = "/sys/class/sec/sec_ir/ir_send"
    private val HAL_DIRS = listOf("/system/lib/hw", "/vendor/lib/hw", "/system/lib64/hw", "/vendor/lib64/hw")

    fun secIrMissing(
        halDirs: List<java.io.File> = HAL_DIRS.map { java.io.File(it) },
        secClass: java.io.File = java.io.File("/sys/class/sec"),
    ): Boolean = try {
        val usesSecIr = halDirs.any { dir ->
            dir.listFiles()?.any { f ->
                f.name.startsWith("consumerir.") && f.name.endsWith(".so") && f.length() < 1_000_000 &&
                    contains(f.readBytes(), SEC_IR_SEND.toByteArray(Charsets.US_ASCII))
            } == true
        }
        val entries = secClass.list()
        usesSecIr && entries != null && "sec_ir" !in entries
    } catch (e: Exception) {
        false
    }

    private fun contains(hay: ByteArray, needle: ByteArray): Boolean {
        outer@ for (i in 0..hay.size - needle.size) {
            for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
            return true
        }
        return false
    }
}
