package com.agentlray.app

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * PRoot + Node 子进程生命周期管理（design-android-mobile-app §4.2 / §7.1 / §7.2 / §7.3）。
 *
 * 关键约束：
 * - 串行化：任何时刻至多一个 proot 子进程存活。start()/stop() 都经单线程 executor 排队，
 *   避免快速前后台切换时新旧进程并存撞薄服务端口（EADDRINUSE）。
 * - start()：spawn proot → 轮询 GET /api/version（200ms，≤20s）→ 就绪回调。
 * - stop()：SIGTERM（proot --kill-on-exit 连带清 Node），3s 后 SIGKILL。
 * - 非主动退出 → 指数退避重启（1s/2s/4s，最多 3 次）；超限 → 错误回调（错误屏）。
 *
 * 该对象由 App 单例持有，不绑定 Activity 生命周期。
 */
class NodeRuntimeManager(
    private val context: Context,
    private val logRing: RuntimeLogRing,
    private val layoutProvider: () -> RootfsInstaller.Layout,
) {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "node-runtime").apply { isDaemon = true } }
    private val running = AtomicBoolean(false)
    private var process: Process? = null

    /** 就绪/错误/退出回调（主线程派发由调用方决定）。 */
    var onReady: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onExit: ((Int) -> Unit)? = null
    /** 首启解压进度（D-2）：转发给 Activity 注入占位页（百分比 + 剩余时间）。 */
    var onProgress: ((RootfsInstaller.Progress) -> Unit)? = null

    private var restartCount = 0
    /**
     * 「用户/壳主动停止」标记：置位后 [maybeRestart] 不再自愈重启。
     *
     * `@Volatile`：由 executor 线程写、被 "node-waiter" 线程读（见 [maybeRestart] 的调用点）。
     * **任何** [start] 都必须先清零——否则一次 stop（退后台超窗、[RuntimeService.onTaskRemoved]）
     * 之后，同进程内后续崩溃会被 [maybeRestart] 的 `if (userStopped) return` 永久短路，
     * 既不重启也不报错，WebView 停在指向已退进程的死页面。
     */
    @Volatile
    private var userStopped = false
    /**
     * 本机接口令牌（C-1）：首次启动随机生成后**持久化到 filesDir/ui-token**，经 env
     * `AGENTLRAY_UI_TOKEN` 传给 Node（不走 TCP）。WebView 用 `GET /?token=` 换 HttpOnly
     * cookie 后正常访问；令牌跨进程/跨升级稳定 → 已兑换的 cookie 不会因运行时重启失效。
     * filesDir 是应用私有目录，其他应用不可读。
     */
    @Volatile
    private var uiTokenValue: String? = null
    val uiToken: String?
        get() = uiTokenValue

    /**
     * 薄服务进程代号：每次**新 spawn** 成功后递增，进程存活期间不变。
     *
     * 供壳判定「WebView 里的页面是否仍对应当前薄服务进程」：代号相同说明服务没重启过，
     * 回前台必须纯复用页面（reload 会丢掉 SPA 状态：当前会话、滚动位置、SSE 增量）；
     * 代号变化（退后台防抖被杀后重启、崩溃重启）说明旧页面已指向退出的进程，需要重新导航。
     * 仅作为「是否同一次服务生命周期」的判据，不承担版本/健康语义。
     */
    @Volatile
    var generation: Int = 0
        private set

    fun start() {
        executor.execute {
            // 每次 start 都是一次新的「用户意图」：必须清除主动停止标记并重置重启预算。
            // 否则一次 stop()（退后台超窗、任务被划掉）之后，本进程内后续崩溃会被
            // [maybeRestart] 的 `if (userStopped) return` 永久短路——既不重启也不报错。
            userStopped = false
            restartCount = 0
            val alreadyHealthy = synchronized(this) { running.get() && isHealthy() }
            if (alreadyHealthy) {
                Log.i(TAG, "运行时已就绪，跳过重启")
                onReady?.invoke()
                return@execute
            }
            shutdownProcess()
            spawnAndAwait()
        }
    }

    /** 异步停止（排队到 executor 串行执行）。 */
    fun stop() {
        executor.execute { stopInternal(PROCESS_GRACE_MS) }
    }

    /**
     * 同步停止：SIGTERM → 等待最久 [graceMs]（proot `--kill-on-exit` 连带清理 Node）→ 必要时
     * SIGKILL，**完成后再返回**。用于进程/服务即将被系统回收、异步队列可能来不及执行的场景
     * （任务被划掉、前台服务超时）：此时若只把 SIGTERM 塞进 daemon executor，进程可能在
     * 线程跑起来之前就被销毁，proot/Node 变成孤儿继续占用 3801。
     *
     * 仍**经 executor 串行执行**（不绕过「至多一个 proot」的约束）：先同步置位停止标记
     * 阻止 waiter 线程重启，再入队等待。若 executor 正忙于一次 spawn 的 20s 探测而超时，
     * 兜底直接 SIGKILL，避免阻塞调用方（可能是主线程/即将被杀的进程）。
     */
    fun stopBlocking(graceMs: Long = STOP_GRACE_MS) {
        userStopped = true
        running.set(false)
        val task = try {
            executor.submit { shutdownProcess(graceMs) }
        } catch (e: Exception) {
            null
        }
        if (task != null) {
            try {
                task.get(graceMs + KILL_WAIT_MS, TimeUnit.MILLISECONDS)
                Log.i(TAG, "运行时已停止（同步）")
                return
            } catch (e: Exception) {
                Log.w(TAG, "同步停止等待超时，直接强杀：${e.message}")
            }
        }
        val proc = synchronized(this) {
            val p = process
            process = null
            p
        }
        proc?.destroyForcibly()
        deletePid()
    }

    /** 立即 SIGKILL（进程退出兜底 / onDestroy）。同时置位 [userStopped]，阻止 waiter 线程重启。 */
    fun killNow() {
        userStopped = true
        running.set(false)
        process?.destroyForcibly()
        process = null
        deletePid()
    }

    private fun stopInternal(graceMs: Long) {
        userStopped = true
        running.set(false)
        shutdownProcess(graceMs)
        Log.i(TAG, "运行时已停止")
    }

    // ---- 内部：spawn + 探测 ----

    private fun spawnAndAwait() {
        var layout = try {
            layoutProvider()
        } catch (e: Exception) {
            Log.e(TAG, "运行时布局/解压失败", e)
            onError?.invoke("运行时解压失败：${e.message}")
            return
        }
        if (!layout.nodeBin.isFile) {
            // 自愈：陈旧/残缺 rootfs（历史竞态、进程被杀、磁盘不足）删除后重建一次。
            val facts = describeRootfs(layout)
            logRing.append("", "rootfs 缺 node，尝试重建：$facts")
            layout.runtimeDir.resolve("rootfs").deleteRecursively()
            layout.runtimeDir.resolve(".rootfs.version").delete()
            val repaired = try {
                layoutProvider()
            } catch (e: Exception) {
                onError?.invoke("运行时解压失败：${e.message}")
                return
            }
            layout = repaired
            if (!repaired.nodeBin.isFile) {
                onError?.invoke("rootfs 内缺少 node：${repaired.nodeBin}\n$facts")
                return
            }
        }
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val proot = File(nativeDir, PROOT_NAME)
        val loader = File(nativeDir, LOADER_NAME)
        if (!proot.isFile) {
            onError?.invoke("缺少 proot 二进制（jniLibs/${PROOT_NAME}）")
            return
        }

        RuntimeWatchdog.cleanupOrphan(layout, logRing)

        // DNS：用 Android 宿主 DNS 覆盖 rootfs 内 /etc/resolv.conf（构建期只有兜底值）。
        // 不注入时 PRoot 内 glibc 解析报 EAI_AGAIN，dsh 等出站请求全部失败。
        val dns = ResolvConf.apply(context, layout.rootfsDir)
        logRing.append("", if (dns.isEmpty()) "resolv.conf：保留兜底 DNS" else "resolv.conf：${dns.joinToString(",")}")

        val token = ensureUiToken()
        val command = buildCommand(layout, proot, token)
        val pb = ProcessBuilder(command)
        pb.directory(layout.appDir)
        pb.redirectErrorStream(true)
        val env = pb.environment()
        // PRoot loader 与临时目录（§4.2/§4.3）；loader 用 nativeLibraryDir 中的 lib*.so。
        env["PROOT_LOADER"] = loader.absolutePath
        env["PROOT_TMP_DIR"] = File(layout.runtimeDir, "tmp").apply { mkdirs() }.absolutePath
        // 部分内核 seccomp 敏感时的兜底开关（可按需开启，P0 实测）。
        if (File(layout.runtimeDir, "no-seccomp").isFile) env["PROOT_NO_SECCOMP"] = "1"

        // 令牌脱敏后再进日志环：日志会显示在错误屏、debug 构建还会同步到 /sdcard。
        logRing.append("", "spawn: ${command.joinToString(" ").replace(token, "***")}")
        val proc = try {
            pb.start()
        } catch (e: Exception) {
            Log.e(TAG, "启动 proot 失败", e)
            onError?.invoke("启动运行时失败：${e.message}")
            return
        }
        synchronized(this) {
            process = proc
            running.set(true)
            // 新进程 = 新生命周期：壳据此判定已有页面是否需要重新导航（见 [generation]）。
            generation += 1
        }
        writePid(pidOf(proc))

        // 读 stdout/stderr → 环形缓冲（独立线程，直到流关闭）。
        Thread({
            try {
                proc.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach { logRing.append("node", it) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "读取运行时输出结束：${e.message}")
            }
        }, "node-stdout").apply { isDaemon = true }.start()

        // 进程退出监听（等待 + 重启策略）。
        Thread({
            val code = try {
                proc.waitFor()
            } catch (e: InterruptedException) {
                -1
            }
            synchronized(this) {
                if (process === proc) {
                    running.set(false)
                    process = null
                }
            }
            logRing.append("", "proot 退出 code=$code")
            onExit?.invoke(code)
            maybeRestart(code)
        }, "node-waiter").apply { isDaemon = true }.start()

        // 健康探测（≤20s）。
        val ready = awaitHealthy(20_000)
        if (ready) {
            restartCount = 0
            // D-1/A-4：服务端已起来 → 补报一次当前网络状态（壳启动期间的首次上报会因薄服务端口未就绪
            // 未监听而失败）；若此刻正处于系统阻断状态，前端横幅会立即出现。
            runCatching { NetworkWatch.reportCurrent() }
            onReady?.invoke()
        } else if (running.get()) {
            onError?.invoke("运行时启动超时（20s 内 /api/version 不可达）")
        }
    }

    /**
     * 取子进程 pid：Android 的 `java.lang.Process` 未公开 `pid()`（仅桌面 JDK 有），
     * 反射 libcore `ProcessImpl.pid` 字段；失败返回 -1（watchdog 会跳过该 pid 文件）。
     */
    /** 失败诊断：rootfs 顶层条目与大小，便于区分「没解压」与「解压残缺」。 */
    private fun describeRootfs(layout: RootfsInstaller.Layout): String {
        val dir = layout.rootfsDir
        val names = dir.list()?.sorted()?.take(12) ?: emptyList()
        val sizeMb = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() } / (1024.0 * 1024.0)
        return "rootfs=${dir.absolutePath} exists=${dir.isDirectory} " +
            "sizeMB=${"%.1f".format(sizeMb)} entries=$names"
    }

    private fun pidOf(p: Process): Long {
        return try {
            val f = p.javaClass.getDeclaredField("pid").apply { isAccessible = true }
            (f.get(p) as? Number)?.toLong() ?: -1L
        } catch (e: Exception) {
            Log.w(TAG, "读取子进程 pid 失败：${e.message}")
            -1L
        }
    }

    /**
     * 解析本机令牌（见 [uiToken] 注释）：内存 → filesDir/ui-token → 新建。
     * SecureRandom + Base64 URL 安全字符集，256 bit。写入为「临时文件 + rename」，
     * 中途被杀不会留下半截令牌（否则下次启动会读到残缺值导致 cookie 立刻失效）。
     */
    @Synchronized
    private fun ensureUiToken(): String {
        uiTokenValue?.let { return it }
        val file = File(context.filesDir, TOKEN_FILE)
        val existing = runCatching { file.readText().trim() }.getOrNull().orEmpty()
        if (existing.isNotEmpty()) {
            uiTokenValue = existing
            return existing
        }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val token = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        runCatching {
            val tmp = File(context.filesDir, "$TOKEN_FILE.tmp")
            tmp.writeText(token)
            if (!tmp.renameTo(file)) {
                file.writeText(token)
                tmp.delete()
            }
        }
        uiTokenValue = token
        return token
    }

    /** 已成功兑换 cookie 的令牌（供 MainActivity 判断是否需要重新导航）。 */
    fun exchangedToken(): String? = runCatching { File(context.filesDir, TOKEN_EXCHANGED_FILE).readText().trim() }.getOrNull()?.ifEmpty { null }

    fun markExchanged(token: String?) {
        runCatching {
            val file = File(context.filesDir, TOKEN_EXCHANGED_FILE)
            if (token == null) file.delete() else file.writeText(token)
        }
    }

    private fun buildCommand(layout: RootfsInstaller.Layout, proot: File, token: String): List<String> {
        // 依赖库（libtalloc/libandroid-shmem）与 libproot.so 同在 nativeLibraryDir：
        // proot 的 DT_RUNPATH 已在构建期改为 ${ORIGIN}（fetch-proot.sh 用 patchelf 改写）。
        // 不能用 LD_LIBRARY_PATH —— Android 8+ 的 bionic linker 对 app 进程忽略它。
        return listOf(
            proot.absolutePath,
            "--kill-on-exit",
            "-0",
            "-r", layout.rootfsDir.absolutePath,
            "-b", "${layout.appDir.absolutePath}:/opt/agentlray",
            "-b", "${layout.dataDir.absolutePath}:/home/agentlray/.agentlray",
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-w", "/opt/agentlray",
            "/usr/bin/env",
            "AGENTLRAY_HOME=/home/agentlray",
            "AGENTLRAY_DISABLE_SSH=1",
            "AGENTLRAY_NATIVE_SAVE=1",
            "PORT=${ThinNavigation.thinPort}",
            "HOST=127.0.0.1",
            // 本机接口令牌（C-1）：thin-server 据此对 /api 鉴权；/api/version 保持公开供健康探测。
            "AGENTLRAY_UI_TOKEN=$token",
            // guest 根路径：proot 的 -r rootfsDir 把 guest `/` 映射到 host rootfsDir，
            // 传给 guest 进程的程序路径必须是 guest 视角（宿主绝对路径会被 proot 当 guest 路径解析而失配）。
            layout.nodeGuestPath,
            "/opt/agentlray/bin/thin-server.js",
        )
    }

    private fun awaitHealthy(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (!running.get()) return false
            if (isHealthy()) return true
            try {
                Thread.sleep(200)
            } catch (e: InterruptedException) {
                return false
            }
        }
        return false
    }

    private fun isHealthy(): Boolean {
        return try {
            val conn = URL("http://127.0.0.1:${ThinNavigation.thinPort}/api/version").openConnection() as HttpURLConnection
            conn.connectTimeout = 600
            conn.readTimeout = 800
            conn.requestMethod = "GET"
            val code = conn.responseCode
            conn.disconnect()
            code == 200
        } catch (e: Exception) {
            false
        }
    }

    private fun maybeRestart(exitCode: Int) {
        if (userStopped) return
        if (restartCount >= MAX_RESTARTS) {
            onError?.invoke("运行时崩溃（退出码 $exitCode），已达最大重启次数\n${logRing.tail(200).joinToString("\n")}")
            return
        }
        val delay = BACKOFF_MS[restartCount.coerceAtMost(BACKOFF_MS.lastIndex)]
        restartCount++
        logRing.append("", "非主动退出，${delay}ms 后第 $restartCount 次重启")
        executor.execute {
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                return@execute
            }
            spawnAndAwait()
        }
    }

    private fun shutdownProcess(graceMs: Long = PROCESS_GRACE_MS) {
        val proc = synchronized(this) {
            val p = process
            process = null
            p
        } ?: return
        if (!proc.isAlive) return
        proc.destroy() // SIGTERM
        val deadline = System.currentTimeMillis() + graceMs
        while (proc.isAlive && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(50)
            } catch (e: InterruptedException) {
                break
            }
        }
        if (proc.isAlive) proc.destroyForcibly() // SIGKILL
        // SIGKILL 后短暂等待进程真正回收：awaitTerminate 期间死进程仍 isAlive 的窗口极小，
        // 但必须确认后再返回，否则调用方（如 onTaskRemoved 后的进程销毁）可能先于清理完成。
        runCatching { proc.waitFor(500, TimeUnit.MILLISECONDS) }
        deletePid()
    }

    private fun writePid(pid: Long) {
        try {
            File(layoutProvider().runtimeDir, PID_FILE).writeText(pid.toString())
        } catch (e: Exception) {
            Log.w(TAG, "写 pid 失败", e)
        }
    }

    private fun deletePid() {
        try {
            File(layoutProvider().runtimeDir, PID_FILE).delete()
        } catch (e: Exception) {
            /* ignore */
        }
    }

    companion object {
        private const val TOKEN_FILE = "ui-token"
        private const val TOKEN_EXCHANGED_FILE = "ui-token.exchanged"

        private const val TAG = "AgentLRayRuntime"
        private const val PID_FILE = "node.pid"
        private const val PROOT_NAME = "libproot.so"
        private const val LOADER_NAME = "libproot-loader.so"
        private const val MAX_RESTARTS = 3
        private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000)
        /** SIGTERM 后等待 proot 自行退出的时长；超时转 SIGKILL。 */
        private const val PROCESS_GRACE_MS = 3_000L
        /** [stopBlocking] 的默认宽限期（与 [PROCESS_GRACE_MS] 一致）。 */
        private const val STOP_GRACE_MS = 3_000L
        /** SIGKILL 后等待进程被系统回收的额外时长。 */
        private const val KILL_WAIT_MS = 500L
    }
}
