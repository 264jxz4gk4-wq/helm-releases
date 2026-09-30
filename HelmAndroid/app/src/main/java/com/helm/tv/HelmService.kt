package com.helm.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Hosts the loopback server and keeps it alive while Helm is in use, so a
 * long `adb install` doesn't die halfway when the screen turns off.
 *
 * Plain Service rather than a lifecycle/coroutine one: fewer dependencies
 * and less memory on a 1 GB device.
 */
class HelmService : Service() {

    companion object {
        private const val TAG = "HelmService"
        private const val CHANNEL_ID = "helm_server"
        private const val NOTIFICATION_ID = 1

        @Volatile var serverReady: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, HelmService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }

    private lateinit var adb: AdbManager
    private var server: HelmServer? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())

        adb = AdbManager(applicationContext)
        try {
            server = HelmServer(applicationContext, adb).also { it.start(5_000, false) }
            serverReady = true
            Log.i(TAG, "listening on 127.0.0.1:5001")
        } catch (e: Exception) {
            // Most likely port 5001 is taken by another process.
            Log.e(TAG, "could not start server", e)
        }

        // Warm up the adb server off the main thread so the first tap is fast,
        // and log the adb version: the single most useful line when debugging
        // a new device ("does the bundled binary even run here?").
        Thread {
            val v = adb.version()
            Log.i(TAG, "bundled adb: exit=${v.exitCode} ${v.combined.lineSequence().firstOrNull()}")
            if (adb.isAvailable) adb.startServer()
        }.apply { isDaemon = true }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serverReady = false
        server?.stop()
        server = null
        Thread { runCatching { adb.killServer() } }.apply { isDaemon = true }.start()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val flags = if (Build.VERSION.SDK_INT >= 23)
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        else
            PendingIntent.FLAG_UPDATE_CURRENT
        val openApp = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)

        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
        else Notification.Builder(this)

        return builder
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.server_running))
            .setSmallIcon(R.drawable.ic_stat_helm)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
    }
}
