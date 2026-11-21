package com.agentlray.app

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import java.io.File
import java.net.InetAddress
import java.nio.file.Files

/**
 * rootfs 的 `/etc/resolv.conf` 注入（design-android-mobile-app；见
 * docs/.local/change-dsh-providers-error-and-logging §8）。
 *
 * 背景：rootfs 由 `debootstrap minbase` 构建，`/etc/resolv.conf` 为空（或指向
 * systemd-resolved stub `127.0.0.53`），PRoot 内没有 systemd-resolved 进程填充它，
 * glibc `getaddrinfo` 直接返回 `EAI_AGAIN` → dsh 等出站请求全部失败。
 *
 * 做法：每次 spawn proot 前，读取 Android 当前网络的 DNS 服务器写入 rootfs 的
 * `/etc/resolv.conf`；读不到时回退构建期写入的兜底值（不覆盖）。
 *
 * 纯函数 [renderResolvConf] 可单测；Android API 只出现在 [systemDnsServers] 与 [apply]。
 */
object ResolvConf {

    private const val TAG = "AgentLRayResolv"

    /**
     * 渲染 resolv.conf 文本。只接受合法的 IPv4/IPv6 字面量，去重且保序。
     * @param servers DNS 服务器地址（来自系统，可能为空或含垃圾值）
     */
    fun renderResolvConf(servers: List<String?>): String {
        val sb = StringBuilder()
        sb.append("# AgentLRay：运行时由宿主 DNS 注入\n")
        for (s in sanitize(servers)) sb.append("nameserver ").append(s).append('\n')
        sb.append("options timeout:2 attempts:2\n")
        return sb.toString()
    }

    /** 过滤非法地址（仅接受 IP 字面量），去重保序。 */
    private fun sanitize(servers: List<String?>): List<String> {
        val out = LinkedHashSet<String>()
        for (raw in servers) {
            val s = raw?.trim().orEmpty()
            if (s.isEmpty()) continue
            if (!isIpLiteral(s)) continue
            out.add(s)
        }
        return out.toList()
    }

    /** 是否为 IPv4 / IPv6 字面量（拒绝主机名，避免把任意字符串写进 resolv.conf）。 */
    private fun isIpLiteral(value: String): Boolean {
        // 快速形状校验：只允许十六进制、点、冒号、百分号（IPv6 zone）。
        if (!value.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == '.' || it == ':' || it == '%' }) {
            return false
        }
        // 必须含分隔符（'.' 或 ':'），否则形如 "deadbeef" 会被当成主机名触发 DNS 查询。
        if (!value.contains('.') && !value.contains(':')) return false
        return try {
            // 字面量解析不会触发 DNS 查询。
            InetAddress.getByName(value) != null
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 读取 Android 当前所有网络的 DNS 服务器（API 21+）。
     * 权限：activeNetwork 的 linkProperties 不要求 ACCESS_NETWORK_STATE；异常一律吞掉返回空。
     */
    fun systemDnsServers(context: Context): List<String> {
        val out = mutableListOf<String>()
        try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return out
            val props = cm.activeNetwork?.let { cm.getLinkProperties(it) }
            for (addr in props?.dnsServers ?: emptyList()) {
                out.add(addr.hostAddress ?: continue)
            }
        } catch (e: Exception) {
            Log.w(TAG, "读取系统 DNS 失败：${e.message}")
        }
        return out
    }

    /**
     * 将宿主 DNS 写入 rootfs 的 /etc/resolv.conf（普通文件）。返回写入的服务器列表；
     * 读不到系统 DNS 时不覆盖（保留构建期兜底），返回空列表。
     */
    fun apply(context: Context, rootfsDir: File): List<String> {
        val servers = sanitize(systemDnsServers(context))
        if (servers.isEmpty()) {
            Log.i(TAG, "未读到系统 DNS，保留 rootfs 内兜底 resolv.conf")
            return emptyList()
        }
        val target = File(rootfsDir, "etc/resolv.conf")
        try {
            target.parentFile?.mkdirs()
            // 若为符号链接（历史 rootfs）先删除，避免写到链接目标。
            // java.io.File 无 isSymbolicLink；用 NIO（API 26+，与 minSdk 一致）。
            if (Files.isSymbolicLink(target.toPath())) target.delete()
            target.writeText(renderResolvConf(servers))
            Log.i(TAG, "已写入 rootfs resolv.conf：$servers")
        } catch (e: Exception) {
            Log.w(TAG, "写入 resolv.conf 失败：${e.message}")
        }
        return servers
    }
}
