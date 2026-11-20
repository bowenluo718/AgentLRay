package com.agentlray.app

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃上报基线（design-android-mobile-app §7.5 / P4）。
 *
 * Node（proot 子进程）已在 RuntimeLogRing 收集 stdout/stderr；原生未捕获异常此前只会
 * 打到 logcat，进程被杀后无从回溯。这里安装默认 UncaughtExceptionHandler，把堆栈 +
 * 运行时日志尾部落盘到 `filesDir/crash/last-crash.txt`（下一次启动可读取/上传）。
 *
 * Sentry/Crashlytics 接入点：在本对象的 write() 成功后追加 SDK 上报即可；当前不引入
 * 外部依赖（企业分发前按 §6.4 接入厂商 SDK）。
 */
object CrashLog {

    private const val TAG = "AgentLRayCrash"
    private const val DIR = "crash"
    private const val FILE = "last-crash.txt"

    fun install(context: Context, logRing: RuntimeLogRing) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                write(context, logRing, thread, error)
            } catch (e: Throwable) {
                Log.e(TAG, "写入崩溃日志失败", e)
            }
            // 交还系统默认处理（终止进程）；不可吞掉异常（§7.3）。
            previous?.uncaughtException(thread, error)
        }
    }

    /** 最近一次崩溃记录（错误屏/诊断页可选展示）。 */
    fun lastCrash(context: Context): String? {
        val file = File(File(context.filesDir, DIR), FILE)
        return if (file.isFile) runCatching { file.readText() }.getOrNull() else null
    }

    private fun write(context: Context, logRing: RuntimeLogRing, thread: Thread, error: Throwable) {
        val dir = File(context.filesDir, DIR).apply { mkdirs() }
        val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val text = buildString {
            appendLine("time: $timestamp")
            appendLine("thread: ${thread.name}")
            appendLine("exception: ${error::class.java.name}: ${error.message}")
            appendLine(error.stackTraceToString())
            appendLine("--- runtime log tail (200) ---")
            appendLine(logRing.tail(200).joinToString("\n"))
        }
        File(dir, FILE).writeText(text)
        Log.e(TAG, "崩溃已记录：${File(dir, FILE).absolutePath}", error)
    }
}
