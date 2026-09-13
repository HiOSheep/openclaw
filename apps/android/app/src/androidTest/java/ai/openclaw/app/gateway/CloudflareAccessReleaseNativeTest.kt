package ai.openclaw.app.gateway

import android.content.pm.ApplicationInfo
import android.system.Os
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sun.jna.Native
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class CloudflareAccessReleaseNativeTest {
  @Test fun minifiedProductionBindingLoadsAndDecryptsGoVector() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    assertEquals(0, instrumentation.targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)
    val pageSize = checkNotNull(InstrumentationRegistry.getArguments().getString("expectedPageSize")).toLong()
    assertEquals(pageSize, Os.sysconf(OsConstants._SC_PAGESIZE))
    // androidTest references do not root app R8 methods. Exercise the production reflection
    // interface already kept for JNA; do not keep test-only Box helpers in release builds.
    val sodium = Native.load("sodium", CloudflareSodiumLibrary::class.java)
    assertEquals("1.0.22", sodium.sodium_version_string())
    assertEquals(0, sodium.sodium_init().coerceAtMost(0))
    val publicKeys = Array(2) { ByteArray(32) }
    repeat(2) {
      val secret = ByteArray(32)
      try {
        assertEquals(0, sodium.crypto_box_keypair(publicKeys[it], secret))
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
      assertEquals(0, sodium.crypto_box_open_easy(message, ciphertext, ciphertext.size.toLong(), nonce, peer, secret))
      assertEquals("{\"app_token\":\"test-only-app-token\",\"org_token\":\"test-only-org-token\"}", message.decodeToString())
      for (index in listOf(0, 24, 108)) {
        val bad = envelope.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
        assertEquals(-1, sodium.crypto_box_open_easy(message, bad.copyOfRange(24, bad.size), (bad.size - 24).toLong(), bad.copyOfRange(0, 24), peer, secret))
      }
    } finally {
      secret.fill(0)
      message.fill(0)
    }
  }
}
