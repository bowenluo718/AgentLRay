package com.agentlray.app

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.util.concurrent.Executors

/**
 * 应用级单例（design-android-mobile-app §2.5 / §7.2）：进程管理不绑定 Activity 生命周期，
 * 旋转/多窗口/短暂前后台切换不影响运行时状态。
 *
 * 启动流程（§7.1）：
 *   onCreate → RootfsInstaller.ensure()（后台线程：解压可能耗时）→ NodeRuntimeManager.start()
 *   就绪后由 MainActivity 加载 WebView（见 MainActivity）。
 */
class App : Application() {

    lateinit var logRing: RuntimeLogRing
        private set
    lateinit var installer: RootfsInstaller
        private set
    lateinit var runtime: NodeRuntimeManager
        private set

    /** 最近一次运行时解压进度（D-2）：MainActivity 的占位页在 onCreate 时已是后设监听，
     *  若此时解压仍在进行，用这个快照立即把进度补上（不必等下一次回调）。 */
    @Volatile
    var lastInstallProgress: RootfsInstaller.Progress? = null
        private set

    override fun onCreate() {
        super.onCreate()
        install(this)
        logRing = RuntimeLogRing()
        // P4 崩溃基线：未捕获异常 → 堆栈 + 运行时日志尾部落盘（Sentry 接入点，§7.5）。
        CrashLog.install(this, logRing)
        installer = RootfsInstaller(this, filesDir) { msg -> logRing.append("", msg) }
        // 首启进度（D-2）：解压条目/字节进度写入日志环并留存快照；占位页由 MainActivity 取用。
        installer.progressListener = { progress ->
            lastInstallProgress = progress
            val percent = progress.fraction?.let { " ${(it * 100).toInt()}%" } ?: ""
            logRing.append(
                "",
                "解压 ${progress.layer}：${progress.entries} 条目$percent",
            )
            // 转发给 Activity（占位页展示百分比/剩余时间，D-2）。
            if (::runtime.isInitialized) runtime.onProgress?.invoke(progress)
        }
        runtime = NodeRuntimeManager(this, logRing) {
            // 惰性求值：ensure() 完成后才有稳定布局；manager 每次 spawn 前重新取，兼弱升级。
            ensureLayout()
        }

        // 解压 + 首次启动放到后台线程，避免阻塞 Application.onCreate（ANR）。
        bootstrapExecutor.execute {
            try {
                installer.ensure()
                Log.i(TAG, "运行时层就绪")
            } catch (e: Exception) {
                Log.e(TAG, "运行时层安装失败", e)
                logRing.append("", "运行时安装失败：${e.message}")
            }
            // D-1：注册系统网络回调（切网/DNS 变化 → 重写 resolv.conf + 上报，触发服务端 kick）。
            // 失败不阻塞启动（部分 ROM 限制回调注册）。
            runCatching { NetworkWatch.start(this@App) }
                .onFailure { e -> logRing.append("", "网络监听未启用：${e.message}") }
            // 即便解压失败也尝试 start（其内部会再次 ensure 并给出错误回调）。
            runtime.start()
        }
    }

    private var cachedLayout: RootfsInstaller.Layout? = null

    // ---- 前后台保活（§7.2）----
    //
    // 防抖状态放在**进程级**而不是 Activity：Activity 可能在后台被系统销毁
    // （「不保留活动」、低内存回收单 Activity），若定时器寄宿在 Activity 的 Handler 上，
    // 销毁即丢失，前台服务与 proot/Node 将无人收敛。这里用 Application 的 Handler，
    // 且 Runnable 只读 [activityStarted]，不持有 Activity 引用（无泄漏）。

    private val debounceHandler = Handler(Looper.getMainLooper())

    /** Activity 是否处于 started（对用户可见）。由 MainActivity 前后台回调维护。 */
    @Volatile
    private var activityStarted = false

    /** 防抖到期：先停薄服务再收起前台服务。期间已回前台（[activityStarted]）则跳过——
     *  进程被冻结时定时器会推迟到解冻后才派发，可能晚于 onStart。 */
    private val stopDebounce = Runnable {
        if (activityStarted) return@Runnable
        Log.i(TAG, "后台防抖到期，停止运行时")
        RuntimeService.stop(this)
        runtime.stop()
    }

    /** 回前台：立即收起前台服务并取消防抖。 */
    fun onActivityStarted() {
        activityStarted = true
        debounceHandler.removeCallbacks(stopDebounce)
        RuntimeService.stop(this)
    }

    /**
     * 退后台：转前台服务保活并启动防抖窗口。
     *
     * 在 `onStop` 立即拉起前台服务（而非靠定时器）：此时代进程仍按「刚离开可见态」计权，
     * Android 12+ 的启动限制通常不触发；偶发被拒时 [RuntimeService.start] 返回 false，
     * 记日志并退化为「仅靠防抖定时器」。**不**改用 `onPause` 预启动——通知栏/权限弹窗都会
     * 触发 onPause，会导致保活通知反复闪现（见 §7.2「不要用 onPause」）。
     */
    fun onActivityStopped() {
        activityStarted = false
        if (!RuntimeService.start(this)) {
            logRing.append("", "前台服务启动被拒（后台启动限制），本次退后台仅靠防抖保活")
        }
        debounceHandler.removeCallbacks(stopDebounce)
        debounceHandler.postDelayed(stopDebounce, STOP_DEBOUNCE_MS)
    }

    /**
     * 用户主动退出（`isFinishing`）：立即收敛，不留后台运行时。
     *
     * 用有限的同步停止而非 `killNow()`：SIGKILL proot 会绕过 `--kill-on-exit`，被 trace 的
     * Node 可能变孤儿；这里给它 1s 优雅退出窗口（正常毫秒级），超时才 SIGKILL。
     */
    fun onActivityFinishing() {
        debounceHandler.removeCallbacks(stopDebounce)
        RuntimeService.stop(this)
        runtime.stopBlocking(FINISH_GRACE_MS)
    }

    /**
     * 取运行时布局（解压单飞在 `RootfsInstaller.ensure()` 内）。
     *
     * 缓存需通过哨兵校验：残缺 rootfs/app（历史竞态、进程被杀）不能因缓存命中而跳过重建。
     */
    @Synchronized
    fun ensureLayout(): RootfsInstaller.Layout {
        cachedLayout?.let { layout ->
            if (layout.nodeBin.isFile && File(layout.appDir, "bin/thin-server.js").isFile) return layout
            cachedLayout = null
        }
        val layout = installer.ensure()
        cachedLayout = layout
        return layout
    }

    companion object {
        private const val TAG = "AgentLRayApp"
        /**
         * 退后台停服务的防抖窗口。5 分钟窗口内回前台：服务进程未换代 → 页面纯复用
         * （见 MainActivity.loadThinUi）；超过则停服务，回前台重启并重新导航。窗口越长越省
         * 「重启 + 重新导航」，但后台 proot/Node 会持续占用 CPU/内存/网络（SSE 连接），
         * 5 分钟是体验与耗电的折中。与 MainActivity 文档一致。
         */
        private const val STOP_DEBOUNCE_MS = 5 * 60 * 1000L
        /** 主动退出时给 proot 的优雅退出窗口（`--kill-on-exit`）。 */
        private const val FINISH_GRACE_MS = 1_000L
        private val bootstrapExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "runtime-bootstrap").apply { isDaemon = true }
        }

        @Volatile
        lateinit var instance: App
            private set

        private fun install(app: App) {
            instance = app
        }
    }
}
