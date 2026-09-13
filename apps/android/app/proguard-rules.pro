-dontwarn org.bouncycastle.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn com.sun.jna.**
-dontwarn java.awt.*
# JNA resolves interface methods and native dispatch symbols by their original names.
-keep class com.sun.jna.* { *; }
-keep class * extends com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }
-keep interface ai.openclaw.app.gateway.CloudflareSodiumLibrary { *; }

# AndroidJUnitRunner's separately shrunk APK calls this shared app class.
# Test-only keep rules cannot retain code removed from the app APK.
-keep class androidx.tracing.Trace {
    public static void beginSection(java.lang.String);
    public static void endSection();
    public static void forceEnableAppTracing();
}
-dontwarn javax.naming.**
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor
