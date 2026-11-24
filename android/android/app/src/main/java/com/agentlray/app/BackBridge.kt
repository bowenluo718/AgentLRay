package com.agentlray.app

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * 页面 → 原生的返回层级上报通道（design-android-system-back）。
 *
 * 薄服务页面（`http://127.0.0.1:<thinPort>`）是 Capacitor 本地服务器之外的源，Capacitor
 * 只向自己的本地源页面注入 `window.Capacitor`，所以这里不用插件，而用一个**无能力**的
 * JavascriptInterface：只接收两个原始值（能否后退、层级名），不做文件/网络/命令/反射，
 * 被页面滥用也不产生副作用。WebView 只加载占位页与 loopback 薄服务（外链交系统浏览器），
 * 攻击面仅限本机薄服务页面自身。
 *
 * JS 调用发生在 WebView 的 JavaBridge 线程，快照必须切回主线程再交给 Activity。
 */
class BackBridge(
    private val onSnapshot: (NativeBackHost.BackSnapshot) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 由页面调用：`window.AgentLRayNative.postBackState(canBack, level)`。 */
    @JavascriptInterface
    fun postBackState(canGoBack: Boolean, level: String?) {
        val snapshot = NativeBackHost.BackSnapshot(canGoBack = canGoBack, level = level.orEmpty())
        mainHandler.post { onSnapshot(snapshot) }
    }
}
