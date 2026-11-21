package com.agentlray.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
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
 *
 * 调试入口：debug 构建在右下角悬浮「同步配置」按钮，把 `filesDir/.agentlray` 递归同步到
 * `/sdcard/com.agentlray.app/files/agentlray`（见 [DataDirSyncer]）。共享外部存储需要
 * 「所有文件访问权限」（API 30+）或 WRITE_EXTERNAL_STORAGE（API ≤29），未授权时先引导授权。
 */
class MainActivity : BridgeActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stopRunnable = Runnable {
        App.instance.runtime.stop()
    }
    private var errorDialog: AlertDialog? = null
    /** 已点击同步但还在等存储权限返回（从系统设置页回来后自动续跑）。 */
    private var pendingSync = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 本地插件注册（Capacitor 7：super 之后注册）。
        registerPlugin(SaveFilePlugin::class.java)
        if (BuildConfig.DEBUG) installSyncFab()

        val runtime = App.instance.runtime
        runtime.onReady = { runOnUiThread { loadThinUi() } }
        runtime.onError = { message -> runOnUiThread { showError(message) } }
    }

    override fun onResume() {
        super.onResume()
        // 从「所有文件访问权限」设置页返回：权限已授予则自动续跑同步。
        if (pendingSync && hasStorageAccess()) {
            pendingSync = false
            startSync()
        }
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

    // ---- 调试：同步 .agentlray 到 /sdcard/agentlray ----

    /** 右下角悬浮按钮（debug 构建才有）。 */
    private fun installSyncFab() {
        val density = resources.displayMetrics.density
        val size = (56 * density).toInt()
        val margin = (16 * density).toInt()
        val fab = TextView(this).apply {
            text = "同步\n配置"
            setTextColor(Color.WHITE)
            textSize = 11f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF2E7D6B.toInt())
            }
            elevation = 6 * density
            contentDescription = "同步 .agentlray 到 /sdcard/agentlray"
            setOnClickListener { onSyncClicked() }
        }
        val lp = FrameLayout.LayoutParams(size, size, Gravity.END or Gravity.BOTTOM).apply {
            setMargins(margin, margin, margin, margin + (72 * density).toInt())
        }
        addContentView(fab, lp)
    }

    private fun onSyncClicked() {
        if (hasStorageAccess()) {
            startSync()
        } else {
            pendingSync = true
            requestStorageAccess()
        }
    }

    /** API 30+ 需「所有文件访问权限」；API ≤29 需 WRITE_EXTERNAL_STORAGE。 */
    private fun hasStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }

    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ),
                )
            } catch (e: Exception) {
                // 部分 ROM 不认带 package 的入口，退回全局列表页。
                startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
            Toast.makeText(this, "请授予「所有文件访问权限」后返回，将自动同步", Toast.LENGTH_LONG).show()
        } else {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_STORAGE) return
        if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            pendingSync = false
            startSync()
        } else {
            pendingSync = false
            Toast.makeText(this, "未授予存储权限，无法写入 /sdcard", Toast.LENGTH_LONG).show()
        }
    }

    private fun startSync() {
        val dst = DataDirSyncer.targetDir(this)
        Toast.makeText(this, "开始同步 .agentlray → $dst", Toast.LENGTH_SHORT).show()
        // 拷贝可能涉及较多文件，放后台线程；结果回主线程提示并写日志环。
        Thread({
            val result = try {
                DataDirSyncer.sync(this)
            } catch (e: Exception) {
                DataDirSyncer.Result(0, 0, 0, listOf("同步异常：${e.message}"))
            }
            val missing = if (result.ok) DataDirSyncer.verify(this) else emptyList()
            val text = buildString {
                append(result.summary())
                if (missing.isNotEmpty()) append("\n校验缺失：${missing.joinToString("、")}")
            }
            App.instance.logRing.append("", text)
            runOnUiThread {
                Toast.makeText(this, text, Toast.LENGTH_LONG).show()
            }
        }, "agentlray-sync").apply { isDaemon = true }.start()
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
        private const val REQ_STORAGE = 1001
    }
}
