package com.agentlray.app

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * 系统返回键决策（design-android-system-back）。
 *
 * 关键回归点：**没有前端快照时绝不能按 history 后退**——冷启动的 WebView history 里
 * 躺着 Capacitor 占位页，`goBack()` 会把用户送回启动屏。
 */
class NativeBackHostTest {

    @Test
    fun `should call frontend when snapshot says it can go back`() {
        val action = NativeBackHost.decide(
            NativeBackHost.BackSnapshot(canGoBack = true, level = "session"),
        )
        assertThat(action).isEqualTo(NativeBackHost.Action.CallFrontend)
    }

    @Test
    fun `should exit when snapshot says it is already at root`() {
        val action = NativeBackHost.decide(
            NativeBackHost.BackSnapshot(canGoBack = false, level = "root"),
        )
        assertThat(action).isEqualTo(NativeBackHost.Action.Exit)
    }

    @Test
    fun `should exit when page has not reported a snapshot`() {
        // 占位页/加载中/刚导航：不吞掉返回键，也不猜测 history。
        assertThat(NativeBackHost.decide(null)).isEqualTo(NativeBackHost.Action.Exit)
    }
}
