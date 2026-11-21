package com.agentlray.app

import android.content.Context
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.util.zip.GZIPInputStream
import org.json.JSONObject
import java.io.File
import java.io.BufferedInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * rootfs / app bundle 解压与版本管理（design-android-mobile-app §3 / §4.4 / §6.1）。
 *
 * 分层（filesDir 下）：
 *   runtime/       rootfs（Ubuntu + Node），随 app 版本重建
 *   runtime/rootfs/
 *   app/           AgentLRay 运行时闭包（package.json/bin/lib/frontend/dist/node_modules）
 *   .agentlray/    持久数据（hosts.json/secret/dsh 凭据），升级永不覆盖
 *
 * 解压来源为 APK assets/runtime/ 下的 `.tgz` + `.manifest.json`：
 *   - SHA-256 校验（防解压损坏/篡改），失败重建；
 *   - 「临时目录 + rename」原子替换，避免半包；
 *   - 保留 POSIX 权限位与符号/硬链接（Ubuntu 合并 /usr 依赖链接；node 二进制需可执行）。
 *
 * 说明：解压用 Commons Compress（TarArchiveInputStream）+ 内置 GZIPInputStream 实现，
 * 不依赖系统 tar/gzip 命令（toybox tar 不可靠；gzip 解压走 JDK）。
 */
class RootfsInstaller(
    private val context: Context,
    private val filesDir: File,
    /** 进度/失败诊断输出（接入 RuntimeLogRing，供错误屏展示）。 */
    private val logger: (String) -> Unit = {},
) {
    private val abi: String = android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
    private val assetAbi: String = when {
        abi.startsWith("arm64") -> "arm64"
        abi.startsWith("x86_64") -> "x86_64"
        else -> "arm64"
    }

    data class Layout(
        val rootfsDir: File,
        val appDir: File,
        val dataDir: File,
        val runtimeDir: File,
    ) {
        val nodeBin: File get() = File(rootfsDir, "usr/local/bin/node")
        val thinServerEntry: File get() = File(appDir, "bin/thin-server.js")
    }

    /**
     * 计算布局并确保 rootfs/app 已解压到目标版本（仅在首次或升级执行）。
     *
     * `@Synchronized` 单飞：`App.onCreate` 的后台线程与 `MainActivity.onStart → runtime.start()`
     * 会并发调用本方法；若不加锁，两条路径共用 `runtime/rootfs.tmp`，会互相删除 tmp/目标目录，
     * 产生「解压流程正常返回但 target 体积残缺（如缺 usr/local/bin/node）」的竞态。
     */
    @Synchronized
    fun ensure(): Layout {
        val runtimeDir = File(filesDir, "runtime").apply { mkdirs() }
        val rootfsDir = File(runtimeDir, "rootfs")
        val appDir = File(filesDir, "app")
        val dataDir = File(filesDir, ".agentlray").apply { mkdirs() }

        // PRoot 运行库（libtalloc/libandroid-shmem，文件名含 .2，jniLibs 不收）→ filesDir/runtime/lib，
        // NodeRuntimeManager 设 LD_LIBRARY_PATH 指向此处。
        val libDir = File(runtimeDir, "lib")
        copyNativeLibs(libDir)

        val version = buildVersionTag()
        // 就绪判定除版本标记外，还要求关键路径存在：陈旧/半成品目录（历史竞态或进程被杀）
        // 会被判定为「未就绪」并自动重建，而不是把残缺 rootfs 交给运行时。
        if (!isReady(rootfsDir, version, File(rootfsDir, NODE_REL))) {
            extractLayer(
                target = rootfsDir,
                versionMarker = File(runtimeDir, ".rootfs.version"),
                version = version,
                assetNames = listOf("rootfs-$assetAbi.tgz", "rootfs-$assetAbi.manifest.json"),
            )
        }
        if (!isReady(appDir, version, File(appDir, THIN_SERVER_REL))) {
            extractLayer(
                target = appDir,
                versionMarker = File(appDir, ".version"),
                version = version,
                assetNames = listOf("app-bundle.tgz", "app.manifest.json"),
            )
        }
        // bind target 预创建（PRoot -b 目标必须存在；见 §4.2）。
        File(rootfsDir, "opt/agentlray").mkdirs()
        File(rootfsDir, "home/agentlray/.agentlray").mkdirs()
        return Layout(rootfsDir, appDir, dataDir, runtimeDir)
    }

    private fun copyNativeLibs(libDir: File) {
        val names = try {
            context.assets.list("runtime/lib") ?: emptyArray()
        } catch (e: Exception) {
            emptyArray()
        }
        if (names.isEmpty()) return
        libDir.mkdirs()
        for (name in names) {
            val dest = File(libDir, name)
            if (dest.isFile && dest.length() > 0) continue
            try {
                context.assets.open("runtime/lib/$name").use { input ->
                    dest.outputStream().use { out -> input.copyTo(out) }
                }
                dest.setExecutable(false, false)
                dest.setReadable(true, false)
            } catch (e: Exception) {
                Log.w(TAG, "拷贝运行库失败：$name", e)
            }
        }
    }

    private fun buildVersionTag(): String {
        val name = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
        } catch (e: Exception) {
            "0"
        }
        val code = try {
            val pi = context.packageManager.getPackageInfo(context.packageName, 0)
            @Suppress("DEPRECATION")
            pi.versionCode.toLong()
        } catch (e: Exception) {
            0L
        }
        return "$name-$code-$assetAbi"
    }

    private fun isReady(target: File, version: String, required: File): Boolean {
        val marker = if (target.name == "rootfs") File(target.parentFile, ".rootfs.version") else File(target, ".version")
        return target.isDirectory && target.list()?.isNotEmpty() == true &&
            marker.isFile && marker.readText().trim() == version &&
            required.isFile
    }

    private fun extractLayer(target: File, versionMarker: File, version: String, assetNames: List<String>) {
        val tarName = assetNames[0]
        val manifestName = assetNames[1]
        val required = requiredPathFor(tarName)
        Log.i(TAG, "解压运行时层 $tarName → $target")
        logger("解压 $tarName → ${target.name}")
        val manifest = readManifest(manifestName)
        verifySha256(tarName, manifest.optString("sha256"))

        val tmp = File(target.parentFile, "${target.name}.tmp")
        if (tmp.exists()) tmp.deleteRecursively()
        tmp.mkdirs()
        val startedAt = System.currentTimeMillis()
        try {
            val entries = untarGzip(tarName, tmp)
            val secs = (System.currentTimeMillis() - startedAt) / 1000.0
            logger("解压 $tarName 完成：$entries 条目 / ${"%.1f".format(secs)}s")
            // 解压后校验：防止「流程正常结束但内容残缺」（磁盘/流异常、并发残留）静默通过。
            val sentinel = File(tmp, required)
            if (!sentinel.isFile) {
                throw IllegalStateException("解压结果残缺：$tarName 缺少 $required（$entries 条目）")
            }
            // 原子替换
            if (target.exists()) target.deleteRecursively()
            if (!tmp.renameTo(target)) {
                // rename 跨挂载失败时的兜底拷贝
                tmp.copyRecursively(target, overwrite = true)
                tmp.deleteRecursively()
            }
            versionMarker.parentFile?.mkdirs()
            versionMarker.writeText(version)
            logger("运行时层就绪：${target.name}（$entries 条目）")
        } catch (e: Exception) {
            Log.e(TAG, "解压失败：$tarName", e)
            logger("解压失败 $tarName：${e.message}")
            tmp.deleteRecursively()
            throw IllegalStateException("运行时解压失败：$tarName（${e.message}）", e)
        }
    }

    /** 各层的完整性哨兵（相对 target 根）。 */
    private fun requiredPathFor(assetName: String): String =
        if (assetName.startsWith("rootfs-")) NODE_REL else THIN_SERVER_REL

    private fun readManifest(name: String): JSONObject {
        return context.assets.open("runtime/$name").use { input ->
            JSONObject(input.bufferedReader().readText())
        }
    }

    private fun verifySha256(assetName: String, expectedHex: String) {
        if (expectedHex.isBlank()) {
            Log.w(TAG, "manifest 缺 sha256，跳过校验：$assetName")
            return
        }
        val actual = context.assets.open("runtime/$assetName").use { digest(it) }
        if (!actual.equals(expectedHex, ignoreCase = true)) {
            throw IllegalStateException("运行时校验失败：$assetName（期望 $expectedHex，实际 $actual）")
        }
    }

    private fun digest(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** 解压 .tgz 到 dest；保留目录/文件/符号链接/硬链接与 POSIX 权限。返回条目数。 */
    private fun untarGzip(assetName: String, dest: File): Int {
        val destCanonical = dest.canonicalFile
        // 1MB 缓冲：逐字节读 AssetInputStream 会显著拖慢 76MB 资产的首启解压。
        context.assets.open("runtime/$assetName").use { raw ->
            BufferedInputStream(raw, 1 shl 20).use { buf ->
                GZIPInputStream(buf).use { gz ->
                    TarArchiveInputStream(gz).use { tar ->
                        var entry: TarArchiveEntry? = tar.nextEntry as? TarArchiveEntry
                        var count = 0
                        while (entry != null) {
                            extractEntry(tar, entry, destCanonical)
                            count++
                            entry = tar.nextEntry as? TarArchiveEntry
                        }
                        return count
                    }
                }
            }
        }
    }

    private fun extractEntry(tar: TarArchiveInputStream, entry: TarArchiveEntry, destCanonical: File) {
        // 防路径穿越（../ 逃逸）。
        val out = File(destCanonical, entry.name).canonicalFile
        if (!out.path.startsWith(destCanonical.path)) {
            throw SecurityException("非法 tar 路径：${entry.name}")
        }
        when {
            entry.isDirectory -> out.mkdirs()
            entry.isSymbolicLink -> {
                out.parentFile?.mkdirs()
                if (out.exists()) out.delete()
                android.system.Os.symlink(entry.linkName, out.absolutePath)
            }
            entry.isLink -> {
                // 硬链接：目标可能先于/后于本项出现；先按相对路径解析，不存在则退化为拷贝。
                out.parentFile?.mkdirs()
                val linkTarget = File(destCanonical, entry.linkName).canonicalFile
                if (linkTarget.isFile) {
                    if (out.exists()) out.delete()
                    linkTarget.copyTo(out, overwrite = true)
                } else {
                    Log.w(TAG, "硬链接目标暂缺，跳过：${entry.name} → ${entry.linkName}")
                }
            }
            else -> {
                out.parentFile?.mkdirs()
                FileOutputStream(out).use { fos -> tar.copyTo(fos) }
                applyMode(out, entry.mode)
            }
        }
    }

    private fun applyMode(file: File, mode: Int) {
        try {
            // Commons Compress 返回 tar 权限位；Android 允许 setExecutable。
            val exec = (mode and 0b001_001_001) != 0
            file.setExecutable(exec, false)
            val read = (mode and 0b100_100_100) != 0
            file.setReadable(read, false)
        } catch (e: Exception) {
            Log.w(TAG, "设置权限失败：${file.name}", e)
        }
    }

    companion object {
        private const val TAG = "AgentLRayRootfs"

        /** rootfs 完整性哨兵：node 二进制（启动前置检查同样依赖它）。 */
        private const val NODE_REL = "usr/local/bin/node"

        /** app bundle 完整性哨兵：薄服务入口。 */
        private const val THIN_SERVER_REL = "bin/thin-server.js"
    }
}
