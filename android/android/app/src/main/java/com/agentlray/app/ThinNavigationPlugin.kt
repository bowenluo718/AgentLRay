package com.agentlray.app

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 内部页面单页签导航控制器（策略见 [ThinNavigation]）。
 *
 * 只有**内部页面**必须留在同一个 WebView 页签：内部页之间的跳转、重定向（如令牌兑换
 * `/?token=` → 302 `/#token=`）、`target="_blank"` 新窗口请求，都在当前页签内消化；
 * 外部链接保持 Capacitor 默认行为，交给外部浏览器。
 *
 * 两层拦截，互为兜底：
 *  1. 插件层 [shouldOverrideLoad]：Capacitor 7.4+ 的导航顺序是「插件 → 应用源 →
 *     allowNavigation HostMask → ACTION_VIEW」，这里内部页返回 false，其余返回 null 交默认策略；
 *  2. 客户端层 [install]：包装 Capacitor 的 `BridgeWebViewClient`（Capacitor 7 用到的回调
 *     全部原样委托），内部页返回 false。这样即使插件钩子未被调用（Capacitor 版本差异）或
 *     已装 APK 打包的是旧 `allowNavigation` 配置，内部页也不会被误交给系统浏览器。
 *
 * 必须经 `Bridge.setWebViewClient(...)` 安装（[install] 内部调用），不能直接给 WebView 赋值：
 * Capacitor 的 `BridgeWebViewClient.onRenderProcessGone` 不调 `super`，WebView 渲染进程崩溃后的
 * `destroy()` 只由 `setWebViewClient` 触发，绕过它会让已失效的 WebView 不被回收。
 *
 * 注册放在 `BridgeActivity.super.onCreate` 之前（Bridge 在 super 内构建），但插件钩子只对
 * 首次导航（占位页）之后的跳转生效；真正的兜底是 super 之后调用的 [install]。
 */
@CapacitorPlugin(name = "ThinNavigation")
class ThinNavigationPlugin : Plugin() {

    override fun shouldOverrideLoad(url: Uri): Boolean? =
        if (ThinNavigation.isInternal(url.toString())) false else null

    /**
     * 包装 Bridge 的 WebViewClient 并经 [com.getcapacitor.Bridge.setWebViewClient] 安装：
     * 内部页内联，其余回调原样委托（本地资源服务、桥、错误页、渲染进程重建都依赖它）。
     * 走 Bridge 的 setter 是为了保留「渲染进程崩溃后销毁 WebView」的语义（见类注释）。
     */
    fun install() {
        val bridge = bridge ?: return
        val delegate = bridge.webViewClient
        val wrapper = object : BridgeWebViewClient(bridge) {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (ThinNavigation.isInternal(request.url.toString())) return false
                return delegate.shouldOverrideUrlLoading(view, request)
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                if (ThinNavigation.isInternal(url)) return false
                return delegate.shouldOverrideUrlLoading(view, url)
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                delegate.shouldInterceptRequest(view, request)

            @Suppress("DEPRECATION")
            override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
                delegate.shouldInterceptRequest(view, url)

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) =
                delegate.onPageStarted(view, url, favicon)

            override fun onPageFinished(view: WebView, url: String?) = delegate.onPageFinished(view, url)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
                delegate.onReceivedError(view, request, error)

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) = delegate.onReceivedHttpError(view, request, errorResponse)

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean =
                delegate.onRenderProcessGone(view, detail)
        }
        bridge.setWebViewClient(wrapper)
    }
}
