package com.agentlray.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

/**
 * 壳 Activity（design-android-mobile-app §4.6 / §7.1 / §7.2）。
 *
 * - 继承 Capacitor BridgeActivity：onCreate 先加载占位页（www/）；
 * - onStart：触发运行时启动（串行化在 NodeRuntimeManager 内），就绪后把 WebView 导航到
 *   本地薄服务（[THIN_ORIGIN]，端口见 [ThinNavigation.thinPort]；方案 A：就绪后手动 loadUrl，
 *   避免未就绪错误页）；
 * - onStop：5s 防抖后停薄服务（吸收对话框/通知栏等短暂切后台）；onStart 取消该防抖；
 * - 失败：弹出含日志尾部的错误对话框，三动作「重试 / 查看日志 / 清除运行时并重装」（D-2）。
 * - 首启：解压进度（D-2）由 App → runtime.onProgress → [renderProgress] 注入占位页；
 *   系统网络变化（D-1/A-4）由 [NetworkWatch] 在 App 内注册，就绪后补报一次网络状态。
 *
 * 注意（§7.2）：不用 onPause（权限弹窗/通知栏会误停）；旋转不重建（configChanges 见 Manifest）。
 *
 * 调试入口：debug 构建在桌面图标长按快捷方式「同步配置」（`res/xml/shortcuts.xml` →
 * [SyncShortcutActivity] → [SyncTask]）把 `filesDir/.agentlray` 递归同步到
 * `/sdcard/com.agentlray.app/files/agentlray`。API ≤29 无法在无界面 Activity 里申请运行时存储
 * 权限时，本 Activity 以 Intent extra [EXTRA_SYNC] 被拉起，授权后自动续跑同步。
 */
class MainActivity : BridgeActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val stopRunnable = Runnable {
        App.instance.runtime.stop()
    }
    private var errorDialog: AlertDialog? = null
    /** 已请求同步但还在等存储权限返回（从系统设置页/权限弹窗回来后自动续跑）。 */
    private var pendingSync = false
    /** 上次成功兑换 cookie 的令牌（持久化）：令牌变化时需强制重载换 cookie。 */
    private var exchangedToken: String? = null
    /** 最近一次解压进度（D-2）：WebView 尚未创建时先留存，onCreate 末尾补发一次。 */
    private var lastProgress: RootfsInstaller.Progress? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // 本地插件注册需早于 super.onCreate：Bridge 在 super 内构建（含首次加载占位页），
        // 之后才注册的插件不会进入该 Bridge。
        registerPlugin(SaveFilePlugin::class.java)
        // 薄服务同源导航放行（见 ThinNavigation）：插件钩子只对首次导航之后的跳转生效，
        // 真正的兜底是 super 之后的 installThinNavigation()。
        registerPlugin(ThinNavigationPlugin::class.java)
        super.onCreate(savedInstanceState)
        installThinNavigation()
        if (BuildConfig.DEBUG) consumeSyncIntent(intent)

        val runtime = App.instance.runtime
        runtime.onReady = { runOnUiThread { loadThinUi() } }
        runtime.onError = { message -> runOnUiThread { showError(message) } }
        // D-2：首启解压进度 → 占位页（百分比 + 剩余时间）。占位页加载完成前先缓存。
        runtime.onProgress = { progress -> runOnUiThread { renderProgress(progress) } }
        App.instance.lastInstallProgress?.let { renderProgress(it) }
    }

    override fun onResume() {
        super.onResume()
        // 从「所有文件访问权限」设置页返回：权限已授予则自动续跑同步。
        if (pendingSync && hasStorageAccess()) {
            pendingSync = false
            SyncTask.start(this)
        }
    }

    /** singleTask：已在前台/后台时再次以 [EXTRA_SYNC] 拉起不会走 onCreate，需在此承接。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (BuildConfig.DEBUG) consumeSyncIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        handler.removeCallbacks(stopRunnable)
        // 串行启动：内部 await 旧进程回收后再 spawn，避免薄服务端口 EADDRINUSE。
        App.instance.runtime.start()
    }

    override fun onStop() {
        super.onStop()
        // 令牌 cookie 落盘（C-1 长效缓存）：WebView 默认异步刷盘，进程被杀/存储回收时
        // 可能丢失 → 每次退后台显式 flush，下次冷启动无需重新兑换令牌。
        runCatching { CookieManager.getInstance().flush() }
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

    /**
     * 内部页面单页签（见 [ThinNavigationPlugin.install]）：薄服务页面及占位页只在这一个
     * WebView 里加载；外部链接保持 Capacitor 默认行为，交给外部浏览器。
     */
    private fun installThinNavigation() {
        val plugin = bridge?.getPlugin("ThinNavigation")?.instance as? ThinNavigationPlugin ?: return
        plugin.install()
    }

    // ---- 调试：同步 .agentlray 到 /sdcard/agentlray（入口：桌面图标长按快捷方式）----

    /**
     * 承接 [EXTRA_SYNC]（API ≤29 由 [SyncShortcutActivity] 拉起）：已授权则直接同步，
     * 否则申请运行时权限并在结果回调 / onResume 中续跑。
     */
    private fun consumeSyncIntent(intent: Intent?) {
        val syncIntent = intent ?: return
        if (!syncIntent.getBooleanExtra(EXTRA_SYNC, false)) return
        // 单例 Activity：消费后清掉，避免后续 onNewIntent/重建重复触发。
        syncIntent.removeExtra(EXTRA_SYNC)
        if (hasStorageAccess()) {
            SyncTask.start(this)
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
            SyncTask.start(this)
        } else {
            pendingSync = false
            Toast.makeText(this, "未授予存储权限，无法写入 /sdcard", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * 加载本地薄服务页面（仅当 url 不是薄服务、或令牌尚未兑换时才导航，避免每次 onStart 重载闪烁）。
     *
     * 本机鉴权（C-1）：导航带 `?token=`，由 thin-server 换成 HttpOnly cookie 后 302 回 `/`；
     * cookie 在 WebView 内持久，后续刷新/SSE 同源自动携带。令牌在 filesDir 持久化，跨运行时
     * 重启不变；`exchangedToken` 记录已兑换的令牌（同样持久化），只有令牌变化时才重新导航，
     * 因此 Activity 重建/前后台切换不会重复加载，也不会误以为已兑换。
     */
    private fun loadThinUi() {
        val webView = bridge?.webView ?: return
        SecurityConfig.harden(webView, BuildConfig.DEBUG)
        val runtime = App.instance.runtime
        val token = runtime.uiToken
        if (exchangedToken == null) exchangedToken = runtime.exchangedToken()
        val current = webView.url
        val onThin = current != null && current.startsWith(THIN_ORIGIN)
        // 光比对令牌值不够：WebView 的 cookie jar 可能被回收/清理，此时链接全部 401，
        // 而 rememberToken 已持久化 → 不能 return，否则永远不再导航兑换（App 卡死在 401）。
        val cookieOk = runCatching {
            CookieManager.getInstance().getCookie(THIN_ORIGIN)?.contains("$COOKIE_NAME=") == true
        }.getOrDefault(false)
        // 原生侧 onStart 会再次调用 runtime.start()（已就绪则同步回调 onReady），若此处直接
        // return 会导致任何 Activity 重建（旋转被 Manifest 拦截，但深色模式/多窗口仍可能）后
        // WebView 停留在占位页；因此 onThin 时一律重新加载薄服务（令牌未变 → cookie 仍在，
        // 首帧直接命中缓存，不产生额外的令牌兑换）。
        if (onThin && token == exchangedToken && cookieOk) {
            webView.reload()
            return
        }
        runtime.markExchanged(token)
        exchangedToken = token
        webView.loadUrl(
            if (token.isNullOrEmpty()) THIN_ORIGIN else "$THIN_ORIGIN/?token=${Uri.encode(token)}"
        )
        // 兑换请求（302 设 cookie）完成后尽快落盘：延迟一拍再 flush，避免趁 cookie 尚未写入。
        handler.postDelayed({ runCatching { CookieManager.getInstance().flush() } }, COOKIE_FLUSH_DELAY_MS)
    }

    /**
     * 首启进度注入（D-2）：原生主动 `evaluateJavascript` 调占位页的
     * `window.__agentlrayProgress(done,total,etaMs)`。不替换 Capacitor 的 WebViewClient
     * （桥的导航/插件回调由它维护）；WebView 未创建时先留存，onCreate 末尾补发一次。
     */
    private fun renderProgress(progress: RootfsInstaller.Progress) {
        lastProgress = progress
        val webView = bridge?.webView ?: return
        // 已导航到薄服务（真实 UI）后不再往页面注入进度脚本。
        if (webView.url?.startsWith(THIN_ORIGIN) == true) return
        pushProgress(webView, progress)
    }

    private fun pushProgress(webView: android.webkit.WebView, progress: RootfsInstaller.Progress) {
        val eta = progress.etaMs ?: -1L
        webView.evaluateJavascript(
            "window.__agentlrayProgress && window.__agentlrayProgress(${progress.bytesDone},${progress.bytesTotal},$eta)",
            null,
        )
    }

    private fun showError(message: String) {
        val logs = App.instance.logRing.tail(200).joinToString("\n")
        runOnUiThread {
            errorDialog?.dismiss()
            // D-2：失败态三动作 —— 重试 / 查看日志 / 清除运行时重装（本地解压/rootfs 损坏时自救）。
            errorDialog = AlertDialog.Builder(this)
                .setTitle("本地薄服务启动失败")
                .setMessage("$message\n\n—— 日志尾部 ——\n$logs")
                .setPositiveButton("重试") { _, _ -> App.instance.runtime.start() }
                .setNeutralButton("查看日志") { _, _ -> showLogsDialog() }
                .setNegativeButton("清除运行时并重装") { _, _ -> resetRuntimeAndRestart() }
                .show()
        }
    }

    /** 查看完整日志（RuntimeLogRing 尾部 500 行），可长按复制。 */
    private fun showLogsDialog() {
        val logs = App.instance.logRing.tail(500).joinToString("\n")
        val view = TextView(this).apply {
            text = logs.ifEmpty { "（暂无日志）" }
            textSize = 11f
            setTextIsSelectable(true)
            val pad = (12 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        AlertDialog.Builder(this)
            .setTitle("运行时日志（尾部 500 行）")
            .setView(android.widget.ScrollView(this).apply { addView(view) })
            .setPositiveButton("关闭", null)
            .show()
    }

    /**
     * 清除运行时并重装（D-2 自救）：删除 `runtime/rootfs` 与 `app`（保留 `.agentlray`
     * 数据：hosts.json / 令牌 / dsh 凭据），随后重新 start —— ensure() 会重新解压。
     *
     * 版本标记随各自目录一起删除：rootfs 标记在 `runtime/.rootfs.version`（rootfs 的兄弟），
     * app 标记在 `app/.version`（目录内），两者都在下面的删除范围内。残留标记会让 ensure()
     * 误判「已就绪」而跳过重建，故删除失败必须记录到日志（由用户从「查看日志」看到）。
     */
    private fun resetRuntimeAndRestart() {
        val runtime = App.instance.runtime
        runtime.stop()
        Thread({
            val files = App.instance.filesDir
            val runtimeDir = java.io.File(files, "runtime")
            val errors = mutableListOf<String>()
            for (target in listOf(
                java.io.File(runtimeDir, "rootfs"),
                java.io.File(runtimeDir, ".rootfs.version"),
                java.io.File(files, "app"),
            )) {
                if (target.exists() && !target.deleteRecursively()) errors += target.name
            }
            App.instance.logRing.append(
                "",
                if (errors.isEmpty()) "已清除运行时（rootfs/app），即将重新解压"
                else "清除运行时部分失败：${errors.joinToString("、")}",
            )
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (errors.isEmpty()) "已清除运行时，正在重新解压…" else "部分文件清除失败，见运行时日志",
                    Toast.LENGTH_SHORT,
                ).show()
                runtime.start()
            }
        }, "agentlray-reset").apply { isDaemon = true }.start()
    }

    companion object {
        /** 由 [SyncShortcutActivity] 附带：本 Activity 拉起后执行一次「同步配置」（debug 构建）。 */
        const val EXTRA_SYNC = "com.agentlray.app.extra.SYNC"
        /** 薄服务同源；端口与 [ThinNavigation.thinPort] 同一真源（NodeRuntimeManager 设置）。 */
        private val THIN_ORIGIN: String get() = "http://127.0.0.1:${ThinNavigation.thinPort}"
        /** 本机鉴权 cookie 名（与 lib/auth.js 的 COOKIE_NAME 一致）。 */
        private const val COOKIE_NAME = "agentlray_token"
        private const val STOP_DEBOUNCE_MS = 5_000L
        /** 导航后延迟刷盘 cookie（等 `/?token=` → 302 的 Set-Cookie 落地）。 */
        private const val COOKIE_FLUSH_DELAY_MS = 3_000L
        private const val REQ_STORAGE = 1001
    }
}
