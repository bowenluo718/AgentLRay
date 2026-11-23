package com.agentlray.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.ContextCompat

/**
 * 应用快捷方式「同步配置」（长按桌面图标弹出，见 `res/xml/shortcuts.xml`）。
 *
 * 无界面：同步在进程级后台线程执行后 Toast 结果并 finish，不拉起 WebView/薄服务。
 *
 * - 已授权存储 → 直接同步；
 * - 未授权（API 30+）→ 跳「所有文件访问权限」设置页并提示重新长按图标触发；
 * - 未授权（API ≤29）→ 转交 [MainActivity]（[MainActivity.EXTRA_SYNC]）走运行时权限并续跑。
 *
 * 同步内容与语义见 [DataDirSyncer]：`filesDir/.agentlray` → `/sdcard/com.agentlray.app/files/agentlray`。
 * 仅 debug 构建在 Manifest 注册本组件（`src/debug/AndroidManifest.xml`）。
 */
class SyncShortcutActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BuildConfig.DEBUG) {
            finish()
            return
        }
        if (hasStorageAccess()) {
            SyncTask.start(this)
        } else {
            // 本 Activity 随即 finish，无法在设置页返回后自动续跑 → 提示用户重新长按图标。
            // 提示必须用 applicationContext：Activity 在 onCreate 返回后立刻销毁，
            // 绑定 Activity 的 Toast 会随之消失。
            requestStorageAccess(applicationContext)
        }
        finish()
    }

    private fun hasStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                PackageManager.PERMISSION_GRANTED
        }

    private fun requestStorageAccess(toastContext: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val granted = runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ),
                )
            }.isSuccess
            if (!granted) {
                // 部分 ROM 不认带 package 的入口，退回全局列表页。
                runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
            }
            Toast.makeText(
                toastContext,
                "请授予「所有文件访问权限」，返回后再次长按图标「同步配置」",
                Toast.LENGTH_LONG,
            ).show()
        } else {
            // API ≤29 的运行时权限必须由前台 Activity 申请：转给 MainActivity 并在其回调里续跑。
            runCatching {
                startActivity(
                    Intent(this, MainActivity::class.java)
                        .putExtra(MainActivity.EXTRA_SYNC, true)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                )
            }
        }
    }
}
