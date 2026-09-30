package com.helm.tv

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The whole UI is ui/index.html from the desktop app, served by HelmServer
 * on loopback and shown here.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HelmWeb"
        private const val URL = "http://localhost:5001/"
    }

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        HelmService.start(this)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true     // the UI keeps saved devices in localStorage
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.mediaPlaybackRequiresUserGesture = false
            setWebViewClient(WebViewClient())

            // Send every JS console message and uncaught error to logcat, so
            // a script problem on an old WebView is visible with:
            //   adb logcat -s HelmWeb
            setWebChromeClient(object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.i(TAG, "${m.messageLevel()} ${m.sourceId()}:${m.lineNumber()} ${m.message()}")
                    return true
                }
            })
        }
        setContentView(webView)
        loadWhenReady()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    /**
     * The server starts in the service, a moment after us. Probe it on a
     * background thread - a socket connect on the main thread throws
     * NetworkOnMainThreadException, even to loopback.
     */
    private fun loadWhenReady() {
        Thread {
            var up = false
            for (attempt in 0 until 60) {           // up to ~15 s on a slow first boot
                if (isServerUp()) { up = true; break }
                Thread.sleep(250)
            }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                if (up) webView.loadUrl(URL)
                else webView.loadDataWithBaseURL(null, startupErrorHtml(), "text/html", "utf-8", null)
            }
        }.apply { isDaemon = true }.start()
    }

    private fun isServerUp(): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", 5001), 250); true }
    } catch (_: Exception) {
        false
    }

    private fun startupErrorHtml(): String = """
        <html><body style="background:#0b0f14;color:#e8eef5;font-family:sans-serif;padding:24px">
        <h2>Helm couldn't start</h2>
        <p>The built-in server didn't come up on port 5001. The usual cause is
        another app already using that port.</p>
        <p>Close Helm fully (swipe it away from recent apps) and open it again.
        If it keeps happening, connect the tablet to a computer and run:</p>
        <pre style="white-space:pre-wrap">adb logcat -s HelmService HelmServer HelmAdb</pre>
        </body></html>
    """.trimIndent()

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
