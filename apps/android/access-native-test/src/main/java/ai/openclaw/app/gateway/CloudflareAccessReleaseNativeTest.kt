package ai.openclaw.app.gateway

import android.content.Context
import android.content.pm.ApplicationInfo
import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dalvik.system.BaseDexClassLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.lang.reflect.Proxy
import java.util.Base64
import java.util.zip.ZipFile

@RunWith(AndroidJUnit4::class)
class CloudflareAccessReleaseNativeTest {
  @Test fun minifiedProductionBindingLoadsAndDecryptsGoVector() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val testContext = instrumentation.context
    val appContext = testContext.createPackageContext("ai.openclaw.app", Context.CONTEXT_INCLUDE_CODE or Context.CONTEXT_IGNORE_SECURITY)
    val testInfo = testContext.applicationInfo
    val appInfo = appContext.applicationInfo
    assertEquals("ai.openclaw.app", appContext.packageName)
    assertNotEquals(testContext.packageName, appContext.packageName)
    assertNotEquals(testInfo.sourceDir, appInfo.sourceDir)
    assertEquals(0, appInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)
    val pageSize = checkNotNull(InstrumentationRegistry.getArguments().getString("expectedPageSize")).toLong()
    assertEquals(pageSize, Os.sysconf(OsConstants._SC_PAGESIZE))
    // The runner owns its runtime; only the installed, optimized app owns JNA and sodium.
    // These app bytes execute in this test process, not the app's startup process.
    val testLoader = testContext.classLoader
    val targetLoader = appContext.classLoader as BaseDexClassLoader
    assertNotSame(testLoader, targetLoader)
    for (name in listOf("com.sun.jna.Native", "ai.openclaw.app.gateway.CloudflareSodiumLibrary")) {
      assertThrows(ClassNotFoundException::class.java) { Class.forName(name, false, testLoader) }
    }
    for (apk in listOf(testInfo.sourceDir) + testInfo.splitSourceDirs.orEmpty()) {
      ZipFile(apk).use { archive ->
        assertFalse(archive.entries().asSequence().any { it.name.substringAfterLast('/') in setOf("libsodium.so", "libjnidispatch.so") })
      }
    }
    val appApks = listOf(appInfo.sourceDir) + appInfo.splitSourceDirs.orEmpty()
    for (name in listOf("sodium", "jnidispatch")) {
      val path = checkNotNull(targetLoader.findLibrary(name))
      val filename = System.mapLibraryName(name)
      val packaged = appApks.any { path.startsWith("$it!/lib/") && path.endsWith("/$filename") }
      assertTrue("$name must resolve from the installed app", packaged || File(path).canonicalFile == File(appInfo.nativeLibraryDir, filename).canonicalFile)
    }
    val native = Class.forName("com.sun.jna.Native", true, targetLoader)
    val binding = Class.forName("ai.openclaw.app.gateway.CloudflareSodiumLibrary", true, targetLoader)
    assertSame(targetLoader, native.classLoader)
    assertSame(targetLoader, binding.classLoader)
    val sodium = checkNotNull(native.getMethod("load", String::class.java, Class::class.java).invoke(null, "sodium", binding))
    assertTrue(Proxy.isProxyClass(sodium.javaClass))
    assertSame(targetLoader, sodium.javaClass.classLoader)
    val keypair = binding.getMethod("crypto_box_keypair", ByteArray::class.java, ByteArray::class.java)
    val open = binding.getMethod("crypto_box_open_easy", ByteArray::class.java, ByteArray::class.java, java.lang.Long.TYPE, ByteArray::class.java, ByteArray::class.java, ByteArray::class.java)
    assertEquals("1.0.22", binding.getMethod("sodium_version_string").invoke(sodium))
    assertEquals(0, (binding.getMethod("sodium_init").invoke(sodium) as Int).coerceAtMost(0))
    val publicKeys = Array(2) { ByteArray(32) }
    repeat(2) {
      val secret = ByteArray(32)
      try {
        assertEquals(0, keypair.invoke(sodium, publicKeys[it], secret))
      } finally {
        secret.fill(0)
      }
    }
    assertFalse(publicKeys[0].contentEquals(publicKeys[1]))
    // Independent Go1.26.4 x/crypto/nacl/box v0.53.0 fixture; fake app token is not an admitted grant.
    val peer = Base64.getUrlDecoder().decode("eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo=")
    val envelope = Base64.getDecoder().decode("4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3mUfpSI3NujJScq2SSYTNjPQHWD/4rcDtGZ4aXmZQQKiucDTkbzLbxWfGKrd5AcTTDtoyjAmnEygNkAiq9mC4Ma37GxgCkQhrX0liw7+6uoTpq9n5Rg==")
    val secret = ByteArray(32) { it.toByte() }
    val message = ByteArray(envelope.size - 40)
    try {
      val nonce = envelope.copyOfRange(0, 24)
      val ciphertext = envelope.copyOfRange(24, envelope.size)
      assertEquals(0, open.invoke(sodium, message, ciphertext, ciphertext.size.toLong(), nonce, peer, secret))
      assertEquals("{\"app_token\":\"test-only-app-token\",\"org_token\":\"test-only-org-token\"}", message.decodeToString())
      for (index in listOf(0, 24, 108)) {
        val bad = envelope.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
        assertEquals(-1, open.invoke(sodium, message, bad.copyOfRange(24, bad.size), (bad.size - 24).toLong(), bad.copyOfRange(0, 24), peer, secret))
      }
    } finally {
      secret.fill(0)
      message.fill(0)
    }
  }
}
