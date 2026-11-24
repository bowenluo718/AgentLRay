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
import android.util.Log
import android.webkit.CookieManager
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

/**
 * 壳 Activity（design-android-mobile-app §4.6 / §7.1 / §7.2）。
 *
 * - 继承 Capacitor BridgeActivity：onCreate 先加载占位页（www/）；
 * - onStart：触发运行时启动（串行化在 NodeRuntimeManager 内），就绪后把 WebView 导航到
 *   本地薄服务（[THIN_ORIGIN]，端口见 [ThinNavigation.thinPort]；方案 A：就绪后手动 loadUrl，
 *   避免未就绪错误页）；
 * - onStop：转前台服务保活，5 分钟后停薄服务（吸收短暂切后台/锁屏/切应用；回前台无需重启）；
 *   onStart 取消该防抖并立即收起前台服务；
 * - 失败：弹出含日志尾部的错误对话框，三动作「重试 / 查看日志 / 清除运行时并重装」（D-2）。
 * - 首启：解压进度（D-2）由 App → runtime.onProgress → [renderProgress] 注入占位页；
 *   系统网络变化（D-1/A-4）由 [NetworkWatch] 在 App 内注册，就绪后补报一次网络状态。
 *
 * - 系统返回（[installBackHandling]）：页面能后退则页面内退一步（层级由薄服务页面经
 *   [BackBridge] 上报，策略见 [NativeBackHost]），否则按原语义退出。
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
    private var errorDialog: AlertDialog? = null
    /** 已请求同步但还在等存储权限返回（从系统设置页/权限弹窗回来后自动续跑）。 */
    private var pendingSync = false
    /** 上次成功兑换 cookie 的令牌（持久化）：令牌变化时需强制重载换 cookie。 */
    private var exchangedToken: String? = null
    /** 最近一次解压进度（D-2）：WebView 尚未创建时先留存，onCreate 末尾补发一次。 */
    private var lastProgress: RootfsInstaller.Progress? = null
    /** 最近一次**成功加载完成**的页面 URL（onPageFinished）；空串 = 未加载完成。 */
    private var thinPageSel: String = ""
    /** 本次导航发出时的薄服务进程代号；页面加载完成时记为 [loadedGeneration]。 */
    private var navGeneration: Int = -1
    /** [thinPageSel] 对应的薄服务进程代号（[NodeRuntimeManager.generation]）；-1 = 无效。 */
    private var loadedGeneration: Int = -1
    /** 页面最近一次上报的返回层级（[BackBridge]）；null = 未上报（占位页/加载中）。 */
    @Volatile
    private var backSnapshot: NativeBackHost.BackSnapshot? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // 本地插件注册需早于 super.onCreate：Bridge 在 super 内构建（含首次加载占位页），
        // 之后才注册的插件不会进入该 Bridge。
        registerPlugin(SaveFilePlugin::class.java)
        // 薄服务同源导航放行（见 ThinNavigation）：插件钩子只对首次导航之后的跳转生效，
        // 真正的兜底是 super 之后的 installThinNavigation()。
        registerPlugin(ThinNavigationPlugin::class.java)
        super.onCreate(savedInstanceState)
        installThinNavigation()
        installBackHandling()
        if (BuildConfig.DEBUG) consumeSyncIntent(intent)

        val runtime = App.instance.runtime
        runtime.onReady = { runOnUiThread { loadThinUi() } }
        runtime.onError = { message -> runOnUiThread { showError(message) } }
        // 进程退出（主动停止或崩溃）：立即作废「页面已加载完成」证据。否则在崩溃/自愈重启
        // 期间，壳可能仍把旧页面当作可复用，留在指向已退出进程的死页面上。自愈重启成功后
        // onReady → loadThinUi 会因 generation 变化重新导航；超预算时由 onError 弹错误屏。
        runtime.onExit = { code ->
            runOnUiThread { invalidatePageEvidence("服务进程退出 code=$code") }
        }
        // D-2：首启解压进度 → 占位页（百分比 + 剩余时间）。占位页加载完成前先缓存。
        runtime.onProgress = { progress -> runOnUiThread { renderProgress(progress) } }
        App.instance.lastInstallProgress?.let { renderProgress(it) }

        requestNotificationPermissionIfNeeded()
    }

    /**
     * Android 13+ 申请通知权限：前台服务依赖它展示「正在后台运行」通知。不申请时
     * `startForeground` 仍成功但通知被系统隐藏，用户看不到保活提示。仅在从未申请过时
     * 弹一次（之后由系统记忆），拒绝不影响保活本身（服务仍计权，Task Manager 可见）。
     */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        runCatching {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
    }

    /**
     * 作废「页面仍可复用」的证据（[thinPageSel]/[loadedGeneration]）。页面一旦失效，
     * 下次 [loadThinUi] 必然重新导航，而不是依赖 `webView.url`（加载失败时它仍是薄服务地址）。
     */
    private fun invalidatePageEvidence(reason: String) {
        if (thinPageSel.isNotEmpty() || loadedGeneration >= 0) {
            Log.i(TAG, "页面证据作废：$reason")
        }
        thinPageSel = ""
        loadedGeneration = -1
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
        // 回前台立即收起保活通知并取消防抖（进程已可见，不再需要前台服务权重）。
        App.instance.onActivityStarted()
        // 串行启动：内部 await 旧进程回收后再 spawn，避免薄服务端口 EADDRINUSE。
        // 服务仍健康时 start() 只回调 onReady，loadThinUi 会识别为「页面可复用」而不重载。
        App.instance.runtime.start()
    }

    override fun onStop() {
        super.onStop()
        // 令牌 cookie 落盘（C-1 长效缓存）：WebView 默认异步刷盘，进程被杀/存储回收时
        // 可能丢失 → 每次退后台显式 flush，下次冷启动无需重新兑换令牌。
        runCatching { CookieManager.getInstance().flush() }
        // 保活：进入 cached 前先转前台服务，并启动进程级防抖（见 App.onActivityStopped）。
        // 只靠定时器不行——cached 进程随时可能被系统整体回收（定时器根本来不及跑）；
        // 而把防抖放在 Application 上，才能覆盖「Activity 后台被销毁」的场景。
        App.instance.onActivityStopped()
    }

    /**
     * Activity 销毁：只有 `isFinishing`（用户主动退出/系统回收整个任务）才立即收敛运行时。
     * `isFinishing=false` 是配置/系统回收单 Activity，进程与运行时留存，防抖已在
     * [App.onActivityStopped] 中投递到进程级 Handler，不随 Activity 销毁而丢失。
     */
    override fun onDestroy() {
        errorDialog?.dismiss()
        if (isFinishing) App.instance.onActivityFinishing()
        super.onDestroy()
    }

    /**
     * 内部页面单页签（见 [ThinNavigationPlugin.install]）：薄服务页面及占位页只在这一个
     * WebView 里加载；外部链接保持 Capacitor 默认行为，交给外部浏览器。
     */
    private fun installThinNavigation() {
        val plugin = bridge?.getPlugin("ThinNavigation")?.instance as? ThinNavigationPlugin ?: return
        plugin.install()
        // 任何新导航（含壳之外的 SPA 重定向/用户点击）都先把旧证据作废：新文档尚未加载完成，
        // 此时复用等同于把用户留在旧内容或空白页。其后的 onPageFinished 才重新建立证据。
        // 返回层级同理：新文档的层级未知，在它重新上报前返回键走系统默认（退出）。
        plugin.onNavigationStarted = {
            invalidatePageEvidence("新导航开始：$it")
            backSnapshot = null
        }
        // 主框架加载失败不会触发 onPageFinished（未配置 Capacitor errorPath），必须单独作废，
        // 否则回前台时 pageIsCurrent 会误用旧证据而跳过重新导航。
        plugin.onMainFrameError = { invalidatePageEvidence("主框架加载失败：$it") }
        // 页面加载完成 → 记录此刻的页面与服务代号。只有拿到这条证据，回前台才允许复用
        // 页面；否则（加载中/加载失败/渲染进程被回收）一律重新导航（见 loadThinUi）。
        plugin.onPageFinished = { url ->
            val finished = url ?: ""
            if (finished.startsWith(THIN_ORIGIN)) {
                thinPageSel = finished
                // 只认「本次导航发出之后」完成的加载：导航前残留的 onPageFinished
                // 不能作为新页面可复用的证据。
                loadedGeneration = navGeneration
            } else if (navGeneration < 0) {
                // 占位页（Capacitor 虚拟源）只在尚未发出过薄服务导航时采信；
                // 迟到的占位页回调不得把刚建立的薄服务页面标记作废。
                thinPageSel = finished
            }
        }
    }

    /**
     * 系统返回键（design-android-system-back）：页面能后退则让页面退一步，否则交回系统
     * 默认语义（`finish()`，即原来的「退出」）。策略与决策见 [NativeBackHost]。
     *
     * 走 `OnBackPressedDispatcher` 而非重写 `onBackPressed()`：targetSdk 35 下兼容层同样
     * 接管预测性返回（Manifest 未开 `enableOnBackInvokedCallback`）。
     */
    private fun installBackHandling() {
        // 页面 → 原生：无能力 JS 桥，只收「能否后退 + 层级名」（见 BackBridge 的信任说明）。
        bridge?.webView?.addJavascriptInterface(
            BackBridge { snapshot ->
                backSnapshot = snapshot
                Log.i(TAG, "返回层级上报：level=${snapshot.level} canGoBack=${snapshot.canGoBack}")
            },
            BACK_BRIDGE_NAME,
        )
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    when (NativeBackHost.decide(backSnapshot)) {
                        NativeBackHost.Action.CallFrontend -> {
                            Log.i(TAG, "系统返回：页面内后退（level=${backSnapshot?.level}）")
                            bridge?.webView?.let { NativeBackHost.callFrontend(it) }
                        }
                        // 置 false 后转发：复用系统默认的 finish 语义，而不是在这里手写
                        // finish()/onBackPressed()（后者在 API 33+ 已废弃且绕过 dispatcher）。
                        NativeBackHost.Action.Exit -> {
                            isEnabled = false
                            onBackPressedDispatcher.onBackPressed()
                        }
                    }
                }
            },
        )
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
        if (requestCode == REQ_NOTIFICATIONS) {
            // 拒绝不影响保活本身（前台服务仍计权，Task Manager 可见通知）。
            if (grantResults.firstOrNull() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                App.instance.logRing.append("", "未授予通知权限：后台保活通知不会展示（服务仍生效）")
            }
            return
        }
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
     * 加载本地薄服务页面。
     *
     * 本机鉴权（C-1）：导航带 `?token=`，由 thin-server 换成 HttpOnly cookie 后 302 回 `/`；
     * cookie 在 WebView 内持久，后续刷新/SSE 同源自动携带。令牌在 filesDir 持久化，跨运行时
     * 重启不变；`exchangedToken` 记录已兑换的令牌（同样持久化），只有令牌变化时才重新导航。
     *
     * 跳过导航的判据（`pageIsCurrent`）必须同时满足，否则会误伤两类场景：
     *  - 页面已成功加载（[thinPageSel] 落在 [THIN_ORIGIN]，由 onPageFinished 记录）——
     *    只认「已加载完成」而不是 `webView.url`：后者在加载中/加载失败时也是薄服务地址，
     *    据此跳过会把用户永久留在空白的错误页；
     *  - 服务进程没换过（`runtime.generation == loadedGeneration`）——退后台防抖被杀、
     *    崩溃重启后旧页面指向已退出的进程，刷新/SSE 全部失败，必须重新导航；
     *  - 令牌一致且 cookie 仍在——WebView 的 cookie jar 可能被回收，此时链接全部 401，
     *    而令牌已经持久化，不能据此跳过（否则永远不再兑换，App 卡在 401）。
     *
     * 满足时**纯复用、绝不 reload**：reload 会重建 SPA，丢失当前会话/滚动位置，并触发
     * 全量重拉与 SSE 重连（每次切后台再回前台都回到主页的根因）。
     * 不满足时才导航，并把当前站内页面作为 `next` 带上，避免兑换 302 后丢失会话上下文。
     */
    private fun loadThinUi() {
        val webView = bridge?.webView ?: return
        SecurityConfig.harden(webView, BuildConfig.DEBUG)
        val runtime = App.instance.runtime
        val token = runtime.uiToken
        if (exchangedToken == null) exchangedToken = runtime.exchangedToken()
        // 光比对令牌值不够：WebView 的 cookie jar 可能被回收/清理，此时链接全部 401，
        // 而 rememberToken 已持久化 → 不能跳过，否则永远不再导航兑换（App 卡死在 401）。
        val cookieOk = runCatching {
            CookieManager.getInstance().getCookie(THIN_ORIGIN)?.contains("$COOKIE_NAME=") == true
        }.getOrDefault(false)
        if (pageIsCurrent(runtime, token, cookieOk)) {
            Log.i(TAG, "薄服务页面有效，复用（不重载）")
            return
        }
        runtime.markExchanged(token)
        exchangedToken = token
        // 冷启动/服务换代：丢弃旧的「已加载」标记，等新页面 onPageFinished 重新建立。
        thinPageSel = ""
        loadedGeneration = -1
        navGeneration = runtime.generation
        webView.loadUrl(exchangeUrl(token, webView.url))
        // 兑换请求（302 设 cookie）完成后尽快落盘：延迟一拍再 flush，避免趁 cookie 尚未写入。
        handler.postDelayed({ runCatching { CookieManager.getInstance().flush() } }, COOKIE_FLUSH_DELAY_MS)
    }

    /** 当前 WebView 里的薄服务页面是否仍可直接复用（判据见 [loadThinUi]）。 */
    private fun pageIsCurrent(runtime: NodeRuntimeManager, token: String?, cookieOk: Boolean): Boolean {
        // 尚未收到薄服务页面的 onPageFinished（仍停在占位页/加载中/渲染进程被回收）。
        if (!thinPageSel.startsWith(THIN_ORIGIN)) return false
        // 薄服务进程换过：旧页面指向已退出的进程，刷新与 SSE 都会失败。
        if (loadedGeneration != runtime.generation) return false
        // 冷启动（本进程还没走过导航）没有可用的 cookie 兑换记录。
        if (exchangedToken == null) return false
        return token == exchangedToken && cookieOk
    }

    /**
     * 兑换 URL：带 `token`，并把 WebView 当前的**站内**页面作为 `next`（服务端只接受站内
     * 绝对路径，见 lib/auth.js 的 safeNextPath）。这样重新导航（冷启动/服务换代）后不会
     * 退回 `/` 丢掉 `?session=&sid=&view=` 的会话上下文。
     */
    private fun exchangeUrl(token: String?, current: String?): String {
        if (token.isNullOrEmpty()) return THIN_ORIGIN
        val next = parseThinNext(current)
        val base = "$THIN_ORIGIN/?token=${Uri.encode(token)}"
        return if (next == null) base else "$base&next=${Uri.encode(next)}"
    }

    /** 从 URL 取出可回跳的站内路径（query 部分；fragment 由服务端禁用，需先剥离）。 */
    private fun parseThinNext(current: String?): String? {
        if (current.isNullOrEmpty() || !current.startsWith(THIN_ORIGIN)) return null
        val afterOrigin = current.removePrefix(THIN_ORIGIN)
        if (!afterOrigin.startsWith("/")) return null
        // 令牌已由 exchangeUrl 重新拼接；这里剔除以免把它带进 next（服务端会拒绝含 `#` 的值）。
        val path = afterOrigin.substringBefore('#')
        return if (path.isEmpty() || path == "/") null else path
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
        private const val TAG = "AgentLRayActivity"
        /** 由 [SyncShortcutActivity] 附带：本 Activity 拉起后执行一次「同步配置」（debug 构建）。 */
        const val EXTRA_SYNC = "com.agentlray.app.extra.SYNC"
        /** 薄服务同源；端口与 [ThinNavigation.thinPort] 同一真源（NodeRuntimeManager 设置）。 */
        private val THIN_ORIGIN: String get() = "http://127.0.0.1:${ThinNavigation.thinPort}"
        /** 本机鉴权 cookie 名（与 lib/auth.js 的 COOKIE_NAME 一致）。 */
        private const val COOKIE_NAME = "agentlray_token"
        /** 导航后延迟刷盘 cookie（等 `/?token=` → 302 的 Set-Cookie 落地）。 */
        private const val COOKIE_FLUSH_DELAY_MS = 3_000L
        private const val REQ_STORAGE = 1001
        private const val REQ_NOTIFICATIONS = 1002
        /** 返回层级上报的 JS 全局名（与 frontend/src/lib/backNavigation.ts 一致）。 */
        private const val BACK_BRIDGE_NAME = "AgentLRayNative"
    }
}
