package com.agentlray.app

import android.content.Context
import android.widget.Toast

/**
 * 调试「同步配置」的执行体：把 `filesDir/.agentlray` 同步到共享外部存储（[DataDirSyncer]）。
 *
 * 进程级单飞（静态标志）：快捷方式可在应用进程未起时冷启动，Activity 随即 finish；
 * 同步必须挂在 Application 级别的后台线程上，不能依赖调用方 Activity 存活。
 * 结果同时写运行日志环与 Toast（用 applicationContext，Activity 已结束时仍能提示）。
 */
object SyncTask {
    private const val TAG_NAME = "agentlray-sync"

    @Volatile
    private var running = false

    fun start(context: Context) {
        val appContext = context.applicationContext
        if (!markRunning()) {
            Toast.makeText(appContext, "同步配置进行中…", Toast.LENGTH_SHORT).show()
            return
        }
        val dst = DataDirSyncer.targetDir(appContext)
        Toast.makeText(appContext, "开始同步 .agentlray → $dst", Toast.LENGTH_SHORT).show()
        Thread({
            try {
                val result = try {
                    DataDirSyncer.sync(appContext)
                } catch (e: Exception) {
                    DataDirSyncer.Result(0, 0, 0, listOf("同步异常：${e.message}"))
                }
                val missing = if (result.ok) DataDirSyncer.verify(appContext) else emptyList()
                val text = buildString {
                    append(result.summary())
                    if (missing.isNotEmpty()) append("\n校验缺失：${missing.joinToString("、")}")
                }
                App.instance.logRing.append("", text)
                toast(appContext, text)
            } finally {
                running = false
            }
        }, TAG_NAME).apply { isDaemon = true }.start()
    }

    /** 原子占位：避免重复点击并发拷贝同一批文件。 */
    @Synchronized
    private fun markRunning(): Boolean {
        if (running) return false
        running = true
        return true
    }

    /** 后台线程弹 Toast：Activity 侧走主线程 Looper，这里显式 post 到主线程。 */
    private fun toast(context: Context, text: String) {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            Toast.makeText(context, text, Toast.LENGTH_LONG).show()
        }
    }
}
