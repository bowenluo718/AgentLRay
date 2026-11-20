package com.agentlray.app

import android.util.Log
import java.io.File

/**
 * 孤儿进程清理（design-android-mobile-app §7.4）。
 *
 * UI 进程被杀时 proot 子进程可能残留并占用 3801。启动前读 runtime/node.pid：
 * 若 pid 存活且 /proc/<pid>/cmdline 命中我们的 proot/thin-server（防误杀复用 pid 的无关进程），
 * 先 SIGKILL 再启动新进程。`proot --kill-on-exit` 另行保证 proot 退出时清理其 tracee。
 */
object RuntimeWatchdog {

    fun cleanupOrphan(layout: RootfsInstaller.Layout, logRing: RuntimeLogRing) {
        val pidFile = File(layout.runtimeDir, "node.pid")
        if (!pidFile.isFile) return
        val pid = pidFile.readText().trim().toLongOrNull() ?: run {
            pidFile.delete()
            return
        }
        if (pid <= 0) {
            pidFile.delete()
            return
        }
        val cmdline = readCmdline(pid)
        if (cmdline == null) {
            // 进程不存在 → 清理陈旧 pid 文件。
            pidFile.delete()
            return
        }
        val ours = cmdline.contains("proot") || cmdline.contains("thin-server") || cmdline.contains("/opt/agentlray")
        if (!ours) {
            Log.w(TAG, "pid $pid 非本应用运行时，跳过误杀")
            pidFile.delete()
            return
        }
        Log.w(TAG, "清理残留运行时 pid=$pid")
        logRing.append("", "清理残留运行时进程 pid=$pid")
        try {
            android.system.Os.kill(pid.toInt(), android.system.OsConstants.SIGKILL)
        } catch (e: Exception) {
            Log.w(TAG, "SIGKILL 失败：${e.message}")
        }
        pidFile.delete()
    }

    private fun readCmdline(pid: Long): String? {
        return try {
            val raw = File("/proc/$pid/cmdline").readBytes()
            if (raw.isEmpty()) return null
            // cmdline 以 \0 分隔参数；替换为空格便于匹配。
            String(raw, Charsets.UTF_8).replace('\u0000', ' ').trim()
        } catch (e: Exception) {
            null
        }
    }

    private const val TAG = "AgentLRayWatchdog"
}
