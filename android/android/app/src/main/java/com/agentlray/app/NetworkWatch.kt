package com.agentlray.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 系统网络变化的观测与上报（D-1 / A-4，design-android-mobile-app）。
 *
 * 三件事：
 *  1. `registerDefaultNetworkCallback` 的 `onAvailable/onLost/onLinkPropertiesChanged`
 *     → 重写 guest 的 `/etc/resolv.conf`（切网后 DNS 会变），并 POST `/api/network/status`；
 *     服务端据此对全部主机 kick（立即探活 + 跳过退避重连），无需壳自己知道主机 id。
 *  2. `onBlockedStatusChanged`（API 29+）→ 写 [RuntimeLogRing] + 上报 `blocked`，
 *     前端顶部横幅提示「系统限制后台联网」。
 *  3. 启动时打印一行策略摘要 [policyLine]（电池优化豁免 / Data Saver / 通知权限），
 *     便于排查「后台被系统掐断」类问题。
 *
 * 线程：网络回调在系统线程，DNS 写入 + HTTP 上报放到单线程 executor（不阻塞回调）。
 * 上报失败不重试排队：下次网络事件/`reportCurrent()`（运行时就绪后调用）会重新上报。
 */
object NetworkWatch {

    private const val TAG = "AgentLRayNetwork"
    private const val TOKEN_FILE = "ui-token"
    /** ConnectivityManager.RESTRICT_BACKGROUNDED（hidden 常量，值为 1）。 */
    private const val RESTRICT_BACKGROUNDED = 1

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "network-watch").apply { isDaemon = true }
    }

    private var callback: ConnectivityManager.NetworkCallback? = null
    private var logRing: RuntimeLogRing? = null
    private var appContext: Context? = null
    /** 最近一次成功写入 resolv.conf 的 DNS（用于判定 dnsChanged）。null=尚未观测。 */
    @Volatile
    private var lastDns: List<String>? = null
    @Volatile
    private var lastTransport: String? = null

    /** 注册网络回调（幂等）。rootfs 未就绪时只记录状态，不写 DNS。 */
    @Synchronized
    fun start(context: Context) {
        if (callback != null) return
        appContext = context.applicationContext
        logRing = App.instance.logRing
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                onNetworkChanged("available")
            }

            override fun onLost(network: Network) {
                onNetworkChanged("lost")
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: android.net.LinkProperties) {
                onNetworkChanged("linkProperties")
            }

            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) {
                logRing?.append("", "系统网络阻断=${blocked}（后台数据限制/省电策略）")
                reportCurrent(blocked = blocked)
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            callback = cb
        } catch (e: Exception) {
            Log.w(TAG, "注册网络回调失败：${e.message}")
            return
        }
        Log.i(TAG, policyLine(context))
        logRing?.append("", "网络策略：${policyLine(context)}")
        // 首次观测（source=start）：写 resolv.conf 并上报一次当前状态。
        onNetworkChanged("start")
    }

    /** 运行时就绪后调用：把「壳启动期间服务端还没起来」的那次上报补上。 */
    fun reportCurrent(blocked: Boolean? = null) {
        val ctx = appContext ?: return
        val effectiveBlocked = blocked ?: isBackgroundRestricted(ctx)
        executor.execute { report(ctx, lastTransport, effectiveBlocked, dnsChanged = false) }
    }

    /** 最近一次观测到的传输方式（wifi/cellular/ethernet/none/other）。 */
    fun currentTransport(context: Context): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return "other"
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    // ---- 内部 ----

    private fun onNetworkChanged(reason: String) {
        val ctx = appContext ?: return
        executor.execute {
            val transport = currentTransport(ctx)
            // rootfs 尚未解压（首启）：记录 transport，DNS 等 spawn 前由 NodeRuntimeManager 注入。
            val rootfs = runCatching { App.instance.installer.lastLayout?.rootfsDir }.getOrNull()
            val servers = if (rootfs != null && rootfs.isDirectory) {
                ResolvConf.apply(ctx, rootfs, source = "network")
            } else {
                emptyList()
            }
            val previous = lastDns
            // dnsChanged 只在「前后两次都拿到了 DNS 且不同」时置真：首次观测由 start 注入，
            // 不应触发一轮无谓的 kick（服务端此时通常还没连上主机）。
            val dnsChanged = previous != null && servers.isNotEmpty() && servers != previous
            if (servers.isNotEmpty()) lastDns = servers
            val transportChanged = lastTransport != null && lastTransport != transport
            lastTransport = transport
            logRing?.append(
                "",
                "网络变化($reason)：transport=$transport dns=${servers.joinToString(",")} " +
                    "dnsChanged=$dnsChanged transportChanged=$transportChanged"
            )
            report(ctx, transport, isBackgroundRestricted(ctx), dnsChanged || transportChanged)
        }
    }

    /**
     * POST /api/network/status：服务端在 transport 变化或 dnsChanged 时对全部主机 kick。
     * 本机资源需要本机令牌（C-1，AGENTLRAY_UI_TOKEN 注入并落 filesDir/ui-token）。
     */
    private fun report(ctx: Context, transport: String?, blocked: Boolean, dnsChanged: Boolean) {
        val token = uiToken(ctx)
        if (token.isEmpty()) return // 运行时尚未生成令牌：下次事件/就绪回调再报。
        val body = buildString {
            append('{')
            append("\"transport\":").append(if (transport == null) "null" else "\"$transport\"").append(',')
            append("\"blocked\":").append(blocked).append(',')
            append("\"dnsChanged\":").append(dnsChanged)
            append('}')
        }
        try {
            // 端口与 NodeRuntimeManager 的 PORT= 同一真源（ThinNavigation.thinPort）。
            val conn = URL("${ThinNavigation.thinOrigin}/api/network/status").openConnection() as HttpURLConnection
            conn.connectTimeout = 1_500
            conn.readTimeout = 2_000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-AgentLRay-Token", token)
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            if (code != 200) Log.w(TAG, "网络状态上报 HTTP $code")
        } catch (e: Exception) {
            // 服务端未就绪/已退出：忽略，下一次事件或 reportCurrent() 会重试。
            Log.i(TAG, "网络状态上报失败（将稍后重试）：${e.message}")
        }
    }

    private fun uiToken(ctx: Context): String {
        App.instance.runtime.uiToken?.let { return it }
        return runCatching { File(ctx.filesDir, TOKEN_FILE).readText().trim() }.getOrDefault("")
    }

    /** 系统是否限制本应用后台联网（Data Saver / 后台数据限制）。 */
    private fun isBackgroundRestricted(ctx: Context): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        return try {
            // RESTRICT_BACKGROUNDED（1）在 API 24 起有效；minSdk 26 故无需版本分支。
            // 注意该常量在 ConnectivityManager 内为 hidden，用数值并注明来源。
            cm.restrictBackgroundStatus == RESTRICT_BACKGROUNDED
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 启动策略摘要（一行日志）：电池优化豁免 / 后台数据限制 / 通知权限。
     * 这三项是「后台被系统掐断」最常见的根因，出现问题时可一眼看出。
     */
    fun policyLine(context: Context): String {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
        val dataSaver = when (context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager) {
            null -> "unknown"
            else -> if (isBackgroundRestricted(context)) "restricted" else "unrestricted"
        }
        val notifications = NotificationManagerCompat.from(context).areNotificationsEnabled()
        return "batteryExempt=$batteryExempt dataSaver=$dataSaver notifications=$notifications"
    }

    /** 测试/诊断：清空观测状态（不注销回调）。 */
    @Synchronized
    fun resetForTest() {
        lastDns = null
        lastTransport = null
    }
}
