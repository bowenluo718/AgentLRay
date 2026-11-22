package com.agentlray.app

import android.app.Application
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
