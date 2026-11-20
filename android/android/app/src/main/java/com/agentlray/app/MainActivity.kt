package com.agentlray.app

import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.getcapacitor.BridgeActivity

/**
 * 壳 Activity（design-android-mobile-app §4.6 / §7.1 / §7.2）。
 *
 * - 继承 Capacitor BridgeActivity：onCreate 先加载占位页（www/）；
 * - onStart：触发运行时启动（串行化在 NodeRuntimeManager 内），就绪后把 WebView 导航到
 *   本地薄服务 http://127.0.0.1:3801（方案 A：就绪后手动 loadUrl，避免未就绪错误页）；
 * - onStop：5s 防抖后停薄服务（吸收对话框/通知栏等短暂切后台）；onStart 取消该防抖；
 * - 失败：弹出含日志尾部的错误对话框，可「重试」重启运行时。
 *
 * 注意（§7.2）：不用 onPause（权限弹窗/通知栏会误停）；旋转不重建（configChanges 见 Manifest）。
 */
class MainActivity : BridgeActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stopRunnable = Runnable {
        App.instance.runtime.stop()
    }
    private var errorDialog: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 本地插件注册（Capacitor 7：super 之后注册）。
        registerPlugin(SaveFilePlugin::class.java)

        val runtime = App.instance.runtime
        runtime.onReady = { runOnUiThread { loadThinUi() } }
        runtime.onError = { message -> runOnUiThread { showError(message) } }
    }

    override fun onStart() {
        super.onStart()
        handler.removeCallbacks(stopRunnable)
        // 串行启动：内部 await 旧进程回收后再 spawn，避免 3801 EADDRINUSE。
        App.instance.runtime.start()
    }

    override fun onStop() {
        super.onStop()
        // 5s 防抖：短暂切后台（系统弹窗/通知栏）不杀进程。
        handler.removeCallbacks(stopRunnable)
        handler.postDelayed(stopRunnable, STOP_DEBOUNCE_MS)
    }

    override fun onDestroy() {
        handler.removeCallbacks(stopRunnable)
        errorDialog?.dismiss()
        if (isFinishing) App.instance.runtime.killNow()
        super.onDestroy()
    }

    /** 就绪后加载本地薄服务页面（仅当 url 不是薄服务时才导航，避免每次 onStart 重载闪烁）。 */
    private fun loadThinUi() {
        val webView = bridge?.webView ?: return
        SecurityConfig.harden(webView, BuildConfig.DEBUG)
        val current = webView.url
        if (current != null && current.startsWith(THIN_ORIGIN)) return
        webView.loadUrl(THIN_ORIGIN)
    }

    private fun showError(message: String) {
        val logs = App.instance.logRing.tail(200).joinToString("\n")
        runOnUiThread {
            errorDialog?.dismiss()
            errorDialog = AlertDialog.Builder(this)
                .setTitle("本地薄服务启动失败")
                .setMessage("$message\n\n—— 日志尾部 ——\n$logs")
                .setPositiveButton("重试") { _, _ -> App.instance.runtime.start() }
                .setNegativeButton("关闭", null)
                .show()
        }
    }

    companion object {
        private const val THIN_ORIGIN = "http://127.0.0.1:3801"
        private const val STOP_DEBOUNCE_MS = 5_000L
    }
}
