package com.agentlray.app

import android.app.Activity
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * WebView 加固与会话安全（design-android-mobile-app §8.1）。
 *
 * - 关闭 file/content 访问、禁止跨域自动加载；release 关闭调试；
 * - 本地薄服务明文 HTTP 仅限 loopback（网络层由 network_security_config.xml 约束）；
 * - 敏感页面（错误屏/凭据）可选 FLAG_SECURE 防截屏。
 *
 * 注意：PRoot 是**同进程权限下的兼容层，不构成安全边界**（§8.1）；此处只做客户端壳加固。
 */
object SecurityConfig {

    /** 对薄服务页面 WebView 施加安全设置（在 loadUrl 前调用）。 */
    fun harden(webView: WebView, debuggable: Boolean) {
        val settings: WebSettings = webView.settings
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.domStorageEnabled = true
        // 调试开关跟随构建类型（release=false）。
        WebView.setWebContentsDebuggingEnabled(debuggable)
    }

    /** 对敏感 Activity 加 FLAG_SECURE（防截屏/录屏）；返回原标记以便恢复。 */
    fun applySecureFlag(activity: Activity, secure: Boolean) {
        if (secure) {
            activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
}
