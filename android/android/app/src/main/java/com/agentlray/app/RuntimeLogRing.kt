package com.agentlray.app

import android.util.Log
import java.util.ArrayDeque

/**
 * proot / Node 子进程 stdout/stderr 的环形缓冲（design-android-mobile-app §7.5）。
 *
 * - 内存保留最近 [capacity] 行，同时写 logcat（便于 `adb logcat` 排查）；
 * - 错误屏读取尾部 [tail] 行展示，崩溃上报把尾部作为 breadcrumb；
 * - 线程安全：proot 的 reader 线程写入，UI 线程读取展示。
 */
class RuntimeLogRing(private val capacity: Int = 500) {
    private val lines = ArrayDeque<String>(capacity)
    private val lock = Any()

    fun append(stream: String, line: String) {
        val entry = if (stream.isEmpty()) line else "[$stream] $line"
        Log.i(TAG, entry)
        synchronized(lock) {
            if (lines.size >= capacity) lines.removeFirst()
            lines.addLast(entry)
        }
    }

    /** 尾部最近 [count] 行（用于错误屏 / 上报）。 */
    fun tail(count: Int = 200): List<String> = synchronized(lock) {
        val n = count.coerceAtMost(lines.size)
        val out = ArrayList<String>(n)
        var skipped = 0
        val skip = lines.size - n
        for (line in lines) {
            if (skipped++ < skip) continue
            out.add(line)
        }
        out
    }

    fun clear() = synchronized(lock) { lines.clear() }

    companion object {
        private const val TAG = "AgentLRayNode"
    }
}
