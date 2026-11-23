package com.agentlray.app

import android.net.Uri

/**
 * 导航策略（design-android-mobile-app §4.6 方案 A 的修正）：
 *
 * - **内部页面**（[isInternal]：薄服务同源，或 Capacitor 占位页虚拟源 `https://localhost`）
 *   一律在**同一个 WebView 页签**内打开，禁止新开页签、禁止跳系统浏览器；
 * - **外部链接**（[isExternalHttp]）保持 Capacitor 默认行为：交给外部浏览器（ACTION_VIEW）；
 * - 其它 scheme（intent/mailto/tel…）同样交 Capacitor 默认策略。
 *
 * 背景：Capacitor `Bridge.launchIntent` 用 `HostMask` 匹配 `server.allowNavigation`，HostMask
 * 只认**裸主机名**（按 `.` 切分、逐段比对 `Uri.getHost()`）；`http://127.0.0.1:3801` 会被切成
 * `["http://127","0","0","1:3801"]`，永远匹配不上 → `loadUrl` 后的 302 重定向被判为外部 URL，
 * 交给系统浏览器，App 内始终停在占位页。修正见 [ThinNavigationPlugin]（客户端层兜底；
 * 插件钩子只对首次导航之后的跳转生效）。
 */
object ThinNavigation {

    /** 当前薄服务端口（NodeRuntimeManager 以 `PORT=` 环境变量启动）。 */
    @Volatile
    var thinPort: Int = DEFAULT_THIN_PORT

    const val DEFAULT_THIN_PORT = 3801

    /** 薄服务同源（令牌兑换、WebView 当前页判定共用）。 */
    val thinOrigin: String get() = "http://127.0.0.1:$thinPort"

    private val THIN_HOSTS = setOf("127.0.0.1", "localhost")

    /**
     * 内部页面：薄服务同源（端口以 [thinPort] 为准），或 App 自身占位页
     * （Capacitor 虚拟源 `https://localhost`；capacitor.config 未设 server.url/hostname）。
     */
    fun isInternal(url: String?): Boolean {
        val uri = parse(url) ?: return false
        if (uri.scheme == APP_VIRTUAL_SCHEME && uri.host == APP_VIRTUAL_HOST) return true
        if (uri.scheme != "http") return false
        if (uri.host !in THIN_HOSTS) return false
        // 端口缺省（`http://127.0.0.1/`）视为 80，不匹配薄服务端口。
        return (if (uri.port != -1) uri.port else 80) == thinPort
    }

    /** 外部 http(s) 链接：交外部浏览器（Capacitor 默认 ACTION_VIEW），不在 App 内打开。 */
    fun isExternalHttp(url: String?): Boolean {
        val uri = parse(url) ?: return false
        return (uri.scheme == "http" || uri.scheme == "https") && !isInternal(url)
    }

    private fun parse(url: String?): Uri? {
        if (url.isNullOrEmpty()) return null
        return runCatching { Uri.parse(url) }.getOrNull()
    }

    private const val APP_VIRTUAL_HOST = "localhost"
    private const val APP_VIRTUAL_SCHEME = "https"
}
