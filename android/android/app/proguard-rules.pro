# ProGuard/R8 规则（design-android-mobile-app §6.4 P4）。
#
# 未在真机/CI 构建验证：启用 minify 后若 release 崩溃，优先检查此处 keep 规则是否缺失。
# 原则：反射入口、JNI 绑定、Capacitor 插件协议类一律保留；其余按 R8 默认优化。

# ---- Capacitor 桥接 ----
# registerPlugin() 传 Class 对象，Capacitor 通过反射实例化/读取 @CapacitorPlugin 注解。
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep @com.getcapacitor.annotation.Permission class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}

# ---- 本工程插件 ----
# SaveFilePlugin 由 MainActivity.registerPlugin(SaveFilePlugin::class.java) 显式注册，
# 但方法经 @PluginMethod 反射调用 → 保留类与方法名。
-keep class com.agentlray.app.SaveFilePlugin { *; }

# ---- 运行时解压：zstd-jni (JNI) + commons-compress ----
-keep class com.github.luben.zstd.** { *; }
-keep class org.apache.commons.compress.** { *; }
-dontwarn com.github.luben.zstd.**
-dontwarn org.apache.commons.compress.**

# ---- Kotlin 元数据（反射读取 data class/协程等） ----
-keep class kotlin.Metadata { *; }
-dontwarn kotlin.**
