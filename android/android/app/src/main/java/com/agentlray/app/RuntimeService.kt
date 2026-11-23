package com.agentlray.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * 后台保活的前台服务（design-android-mobile-app §7.2）。
 *
 * 为什么需要它：界面不可见后进程进入 **cached** 状态，系统随时可能回收整个进程
 * （proot/Node 一起消失），壳里那个「5 分钟后停服务」的定时器根本来不及跑。声明
 * `foregroundServiceType="specialUse"` 并 `startForeground` 后，进程在退后台期间按
 * 前台服务计权，才能在防抖窗口内存活。服务只做保活、不做业务：运行的仍是
 * [NodeRuntimeManager] 管理的同一份 proot/Node。
 *
 * 生命周期由 [MainActivity] 控制：
 *  - `onStop`（退后台）→ [start]：转前台服务，开始 5 分钟防抖；
 *  - `onStart`（回前台）→ [stop]：立即收起通知，进程回到普通优先级；
 *  - 防抖到期 → 壳先 [App.instance.runtime.stop] 再 [stop]。
 *
 * 超时（Android 15 specialUse 上限 6 小时、部分 ROM 更短）由 [onTimeout] 收敛：立即停
 * 薄服务并结束服务，避免系统按 ANR 处理。**不做** `onStopForeground` 收敛——回前台时
 * 正是壳主动 `stopForeground`/`stopService`，此时绝不能停运行时。
 */
class RuntimeService : Service() {

    override fun onBind(intent: Intent?): android.os.IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        } catch (e: Exception) {
            // 后台启动限制 / 通知被禁用等：保活降级为「仅靠防抖定时器」，不影响薄服务可用性。
            Log.w(TAG, "前台服务启动失败，后台保活降级：${e.message}")
            stopSelf()
        }
        // 不 sticky：本服务无法在无人 startForeground 的情况下自行重建（会直接被杀）。
        return START_NOT_STICKY
    }

    /** Android 15+：`specialUse` 前台服务超时。必须尽快停服务，否则应用被 ANR 终止。 */
    override fun onTimeout(startId: Int) = stopRuntimeAndSelf()

    /** Android 15+（带类型信息的重载）。 */
    override fun onTimeout(startId: Int, fgsType: Int) = stopRuntimeAndSelf()

    /**
     * 用户从最近任务里划掉应用：明确「用完了」的信号，直接停运行时并结束服务。
     * 不停的话默认 `stopWithTask=true` 只会收掉服务，proot/Node 变成无人管理的孤儿
     * （要等下次启动的 [RuntimeWatchdog] 才清理，期间一直占着 3801）。
     *
     * 必须用**同步**停止（[NodeRuntimeManager.stopBlocking]）：本回调之后进程很可能立刻被
     * 销毁，把 SIGTERM 丢进异步队列的话线程可能来不及跑，proot 仍然变成孤儿。宽限期取
     * 1s（远小于 5s ANR 阈值）：`proot --kill-on-exit` 正常情况毫秒级退出，超时直接 SIGKILL。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "任务被移除，停止运行时")
        runCatching { App.instance.runtime.stopBlocking(TASK_REMOVED_GRACE_MS) }
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    private fun stopRuntimeAndSelf() {
        Log.i(TAG, "前台服务超时，停止运行时")
        runCatching { App.instance.runtime.stopBlocking(TASK_REMOVED_GRACE_MS) }
        stopSelf()
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_agentlray)
            .setContentTitle(getString(R.string.runtime_notification_title))
            .setContentText(getString(R.string.runtime_notification_text))
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.runtime_notification_channel), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            },
        )
    }

    companion object {
        private const val TAG = "AgentLRayService"
        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "agentlray-runtime"
        /** 任务被划掉/服务超时的同步停止宽限期：远小于 5s ANR 阈值。 */
        private const val TASK_REMOVED_GRACE_MS = 1_000L

        /**
         * 转前台服务（幂等：系统重复调用不会叠加通知）。必须在退后台前调用。
         *
         * 返回是否成功：Android 12+ 后台启动前台服务受限，`startForegroundService` 可能抛
         * `ForegroundServiceStartNotAllowedException`。失败时保活退化为「仅靠防抖定时器」，
         * 由调用方记录到运行时日志（用户在错误屏/日志里能看见，而不是被静默吞掉）。
         */
        fun start(context: Context): Boolean {
            val intent = Intent(context, RuntimeService::class.java)
            return try {
                context.startForegroundService(intent)
                true
            } catch (e: Exception) {
                Log.w(TAG, "拉起前台服务失败：${e.message}")
                false
            }
        }

        /** 收起前台服务（回前台/停运行时后调用）。 */
        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, RuntimeService::class.java)) }
        }
    }
}
