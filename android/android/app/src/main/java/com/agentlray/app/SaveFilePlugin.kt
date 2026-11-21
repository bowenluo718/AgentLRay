package com.agentlray.app

import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import java.io.File

/**
 * 原生保存桥（design-android-mobile-app §7.6）。
 *
 * Android WebView 不支持 blob 下载（URL.createObjectURL + a.download）。前端在
 * `capabilities.nativeSave=true` 且探测到 window.Capacitor.Plugins.SaveFile 时调用本插件：
 *   前端 saveTextFile() → saveFile({ base64, fileName, mimeType }) →
 *   写入 filesDir/exports/<fileName> → FileProvider 授权 → ACTION_SEND 分享面板。
 *
 * 返回 { uri }；用户取消/无分享面板时仍保留文件（写盘成功即 resolve）。
 */
@Suppress("unused")
class SaveFilePlugin : Plugin() {

    @PluginMethod
    fun saveFile(call: PluginCall) {
        val base64 = call.getString("base64", "")
        val rawName = call.getString("fileName", "export.bin")
        val mimeType = call.getString("mimeType", "application/octet-stream") ?: "application/octet-stream"
        if (base64.isNullOrEmpty()) {
            call.reject("base64 必填")
            return
        }
        val fileName = sanitizeFileName(rawName ?: "export.bin")

        val dir = File(context.filesDir, "exports").apply { mkdirs() }
        val file = File(dir, fileName)
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            file.writeBytes(bytes)
        } catch (e: Exception) {
            call.reject("写入文件失败：${e.message}")
            return
        }

        val uri: Uri = try {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        } catch (e: Exception) {
            call.reject("无法生成分享 URI：${e.message}")
            return
        }

        try {
            share(uri, mimeType)
        } catch (e: Exception) {
            // 无分享目标/前台 Activity 缺失：文件已落盘，仍 resolve 供用户手动取用。
            android.util.Log.w("AgentLRaySaveFile", "分享失败：${e.message}")
        }

        call.resolve(JSObject().put("uri", uri.toString()).put("path", file.absolutePath))
    }

    private fun share(uri: Uri, mimeType: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "保存 / 分享导出文件")
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // 从插件（可能有 Activity 上下文）启动分享面板。
        activity?.startActivity(chooser)
    }

    /** 去除路径分隔符与控制字符，防目录穿越/非法文件名。 */
    private fun sanitizeFileName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim()
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "export.bin" else cleaned
    }
}
