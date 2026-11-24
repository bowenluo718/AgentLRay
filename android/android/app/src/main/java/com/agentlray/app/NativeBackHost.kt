package com.agentlray.app

import android.webkit.WebView

/**
 * 系统返回键的「页面内后退」策略（design-android-system-back）。
 *
 * 背景：壳里只有一个 Activity，且 Capacitor 7 的 `BridgeActivity` 不拦截返回键，
 * 系统返回直接 `finish()` → `onStop`/`onDestroy(isFinishing)` → `App.onActivityFinishing()`
 * 停掉本地运行时（用户感知为「App 直接退出」）。薄服务页面是 SPA，页面层级（右/左侧栏
 * 覆盖层、会话详情、子 Agent、子页签、页签）都在 zustand 里，**不产生 WebView history
 * 条目**，因此 `canGoBack()` 不能作为判据——而且在冷启动时它常为 true，指向 Capacitor
 * 占位页，`goBack()` 会把用户送回启动屏。故这里只认前端上报的层级快照。
 *
 * 决策（[decide]）：
 *  - 前端上报「还能后退一步」→ [Action.CallFrontend]（注入 `window.__agentlrayBack()`）；
 *  - 其余（无快照 / 前端已在根层级 / 尚未加载）→ [Action.Exit] 交回系统默认语义。
 *
 * 快照由页面经 `window.AgentLRayNative.postBackState(canBack, level)` 主动上报
 * （[BackBridge]，薄服务页面是外部源，取不到 Capacitor 的 JS 运行时，不能用插件）。
 * 不在按键时同步 `evaluateJavascript` 轮询：异步回调期间的第二次按键会读到「无快照」
 * 而误退出。
 */
object NativeBackHost {

    /** 前端上报的返回层级快照。 */
    data class BackSnapshot(
        /** 前端能否再后退一步（[Level] 非 ROOT）。 */
        val canGoBack: Boolean,
        /** 当前层级名，仅用于日志（如 `session` / `navigation`）。 */
        val level: String,
    )

    sealed interface Action {
        /** 注入前端后退钩子，由页面内后退一步。 */
        data object CallFrontend : Action
        /** 无页面可退：交回系统（finish，即原有退出语义）。 */
        data object Exit : Action
    }

    /**
     * 纯决策函数（可单测）：只有前端明确上报「可后退」时才拦截，绝不猜测 history。
     *
     * @param snapshot 最近一次前端上报；null = 未知（占位页/加载中/未注入）。
     */
    fun decide(snapshot: BackSnapshot?): Action =
        if (snapshot?.canGoBack == true) Action.CallFrontend else Action.Exit

    /** 调用前端钩子：`window.__agentlrayBack && window.__agentlrayBack()`。 */
    fun callFrontend(webView: WebView) {
        webView.evaluateJavascript("window.__agentlrayBack && window.__agentlrayBack()", null)
    }
}
