package com.agentlray.app

import android.content.Context
import android.os.Environment
import java.io.File

/**
 * 调试用：把应用私有目录 `filesDir/.agentlray`（用户数据：hosts.json / settings.json / secret
 * / dsh 凭据）递归同步到共享外部存储 `/sdcard/com.agentlray.app/files/agentlray`，
 * 便于在手机文件管理器里直接查看。
 *
 * 该目录是**共享外部存储根**下自建路径，**需要存储权限**（Android 11+ 为「所有文件访问权限」
 * `MANAGE_EXTERNAL_STORAGE`，见 `MainActivity` 的权限申请）。相比应用专属目录，好处是路径更
 * 直观、不依赖 `Android/data/` 的访问限制。
 *
 * 语义为**镜像覆盖拷贝**：只新增/覆盖，不删除目标侧多余文件（避免误删用户已导出的历史副本）。
 * 符号链接/特殊文件跳过（.agentlray 只存普通文件与目录）。
 */
object DataDirSyncer {

    data class Result(
        val files: Int,
        val dirs: Int,
        val bytes: Long,
        val errors: List<String>,
    ) {
        val ok: Boolean get() = errors.isEmpty()

        fun summary(): String = buildString {
            append("同步完成：$files 文件 / $dirs 目录 / ${"%.1f".format(bytes / 1048576.0)} MB")
            if (errors.isNotEmpty()) {
                append("\n失败 ${errors.size} 项：")
                append(errors.take(3).joinToString("；"))
            }
        }
    }

    /** 目标目录：`/sdcard/com.agentlray.app/files/agentlray`（共享外部存储根下自建路径）。 */
    fun targetDir(context: Context): File =
        File(Environment.getExternalStorageDirectory(), "com.agentlray.app/files/agentlray")

    /** 源目录：`filesDir/.agentlray`。 */
    fun sourceDir(context: Context): File = File(context.filesDir, ".agentlray")

    fun sync(context: Context): Result {
        val src = sourceDir(context)
        val dst = targetDir(context)
        val errors = mutableListOf<String>()
        if (!src.isDirectory) {
            return Result(0, 0, 0, listOf("源目录不存在：${src.absolutePath}"))
        }
        if (!dst.exists() && !dst.mkdirs()) {
            return Result(0, 0, 0, listOf("无法创建目标目录：${dst.absolutePath}"))
        }
        val counters = longArrayOf(0, 0, 0) // files, dirs, bytes
        copyTree(src, dst, counters, errors)
        return Result(counters[0].toInt(), counters[1].toInt(), counters[2], errors)
    }

    private fun copyTree(src: File, dst: File, counters: LongArray, errors: MutableList<String>) {
        val children = src.listFiles()
        if (children == null) {
            errors.add("无法读取 ${src.absolutePath}")
            return
        }
        for (child in children) {
            val target = File(dst, child.name)
            try {
                when {
                    child.isDirectory -> {
                        if (!target.isDirectory && !target.mkdirs()) {
                            errors.add("${child.name}：mkdir 失败")
                            continue
                        }
                        counters[1]++
                        copyTree(child, target, counters, errors)
                    }
                    child.isFile -> {
                        target.parentFile?.mkdirs()
                        child.copyTo(target, overwrite = true)
                        counters[0]++
                        counters[2] += child.length()
                    }
                    else -> errors.add("${child.name}：跳过非普通文件")
                }
            } catch (e: Exception) {
                errors.add("${child.name}：${e.message}")
            }
        }
    }

    /** 拷贝后抽查：确认 hosts.json/settings.json 至少在源里存在时能落到目标。 */
    fun verify(context: Context): List<String> {
        val src = sourceDir(context)
        val dst = targetDir(context)
        val missing = mutableListOf<String>()
        for (name in listOf("hosts.json", "settings.json", "secret")) {
            if (File(src, name).isFile && !File(dst, name).isFile) missing.add(name)
        }
        return missing
    }
}
