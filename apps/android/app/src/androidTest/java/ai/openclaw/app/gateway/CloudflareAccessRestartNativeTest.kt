package ai.openclaw.app.gateway

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.NodeApp
import ai.openclaw.app.SecurePrefs
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Process
import androidx.core.content.pm.PackageInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URI
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import java.util.UUID

/** The CI runner selects each method in a separate process without reinstalling or clearing data. */
@RunWith(AndroidJUnit4::class)
class CloudflareAccessRestartNativeTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val arguments = InstrumentationRegistry.getArguments()
  private val context = instrumentation.targetContext
  private val nonce by lazy { checkNotNull(arguments.getString("restartNonce")).also { require(UUID.fromString(it).toString() == it) } }
  private val source by lazy { checkNotNull(arguments.getString("restartSource")) }
  private val receiptKey get() = "access.restart.proof.$nonce"
  private val fresh by lazy { GatewayEndpoint.manual("restart-fresh-$nonce.example.test", 443, true, "/fresh/socket") }
  private val legacy by lazy { GatewayEndpoint.manual("restart-legacy-$nonce.example.test", 443, true, "/legacy/socket") }
  private val origin by lazy { CloudflareAccessOrigin.from("https://${fresh.host}") }
  private val controlOrigin by lazy { CloudflareAccessOrigin.from("https://restart-control-$nonce.example.test") }
  private val profiles get() = listOf(fresh, legacy)

  @Before fun requireRestartOrchestration() {
    assumeTrue("Requires the two-process restart runner", arguments.containsKey("restartPhase"))
  }

  @Test fun seedAcknowledgedSignOut() =
    runBlocking {
      assertEquals("seed", arguments.getString("restartPhase"))
      assertTargetProcess()
      val initial = SecurePrefs(context)
      assertTrue(
        initial.gatewayRegistry.entries.value
          .isEmpty(),
      )
      assertNull(initial.getString(receiptKey))
      // The frozen pre-Access v1 shape has no accessOrigin. Read it through the production loader.
      val oldProfile =
        JSONObject()
          .put("version", 1)
          .put("activeStableId", legacy.stableId)
          .put("connectedStableIds", JSONArray(listOf(legacy.stableId)))
          .put("entries", JSONArray().put(profile(legacy, "Legacy profile")))
      assertTrue(initial.putStringSynchronously(GatewayRegistryStore.STORAGE_KEY, oldProfile.toString()))
      val prefs = (context.applicationContext as NodeApp).prefs
      val registry = prefs.gatewayRegistry
      assertEquals(legacy.stableId, registry.activeStableId.value)
      assertNull(
        registry.entries.value
          .single()
          .accessOrigin,
      )
      registry.upsert(GatewayRegistryEntry(fresh.stableId, GatewayRegistryEntryKind.MANUAL, "Fresh profile", fresh.host, 443, true, CONNECTED_AT, fresh.contextPath))
      assertTrue(registry.setAccessOrigin(fresh.stableId, origin))
      prefs.setDisplayName("Access restart fixture")
      val device = DeviceIdentityStore.withPrefs(context, prefs).loadOrCreate().deviceId
      // Match the normal ten-minute setup token TTL; the verifier keeps this original absolute deadline.
      val bootstrapExpiresAtMs = System.currentTimeMillis() + 10 * 60 * 1000L
      for (entry in profiles) {
        prefs.saveGatewayCredentials(
          entry.stableId,
          token = "restart-gateway-token",
          bootstrapToken = "restart-bootstrap-token",
          password = "restart-password",
          bootstrapExpiresAtMs = if (entry == fresh) bootstrapExpiresAtMs else null,
        )
        prefs.saveGatewayCustomHeaders(entry.stableId, mapOf("X-Existing-Ingress" to "restart-header"))
        prefs.saveGatewayTlsFingerprint(entry.stableId, "a".repeat(64))
        assertTrue(DeviceAuthStore(prefs).saveToken(entry.stableId, device, "operator", "restart-device-token", listOf("operator.read")))
      }
      val expires = (System.currentTimeMillis() / 1000 + 3600).toDouble()
      val persistence = CloudflareAccessSessionStore.Persistence.securePrefs(prefs)
      assertTrue(persistence.save(origin, session(origin, "signed-out", expires).encode()))
      assertTrue(persistence.save(controlOrigin, session(controlOrigin, "untouched-control", expires).encode()))
      val preserved = independentState(prefs, bootstrapExpiresAtMs)
      val job = SupervisorJob()
      val owner = GatewayIngressController(CoroutineScope(job + Dispatchers.Default), registry, persistence, prefs::loadGatewayCustomHeaders, {})
      try {
        withTimeout(10_000) {
          checkNotNull(owner.signOut(fresh.stableId)).await()
          owner.presentation.first { state -> state.attention?.let { it.stableId == fresh.stableId && it.message == SIGNED_OUT } == true }
        }
        assertNull(persistence.load(origin))
        assertEquals(preserved, independentState(prefs, bootstrapExpiresAtMs))
        assertControl(prefs, expires, this)
        // Flush ordinary preferences too; commit waits for this instance's prior apply writes.
        assertTrue(context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE).edit().commit())
        val receipt =
          identity(prefs)
            .put("phase", "seed")
            .put("expires", expires)
            .put("preserved", preserved)
            .put("bootstrapExpiresAtMs", bootstrapExpiresAtMs)
        assertTrue(prefs.putStringSynchronously(receiptKey, receipt.toString()))
        report(receipt)
      } finally {
        job.cancelAndJoin()
      }
      // Leave only this fixture's durable handoff for the next process; emulator teardown owns cleanup.
    }

  @Test fun verifyAcknowledgedSignOut() =
    runBlocking {
      assertEquals("verify", arguments.getString("restartPhase"))
      assertTargetProcess()
      val prefs = (context.applicationContext as NodeApp).prefs
      // Read the prior process's handoff before any state can be seeded or cleaned up.
      val previous = JSONObject(checkNotNull(prefs.getString(receiptKey)))
      val current = identity(prefs)
      for (key in listOf("nonce", "source", "uid", "package", "process", "apk", "signer", "storage", "instance")) {
        assertEquals(key, previous.get(key), current.get(key))
      }
      assertEquals("seed", previous.getString("phase"))
      assertNotEquals(previous.getInt("pid"), Process.myPid())
      val persistence = CloudflareAccessSessionStore.Persistence.securePrefs(prefs)
      assertNull(persistence.load(origin))
      assertNull(CloudflareAccessSessionStore(this, persistence, retireTransports = {}).snapshot(origin))
      val bootstrapExpiresAtMs = previous.getLong("bootstrapExpiresAtMs")
      assertEquals(previous.getString("preserved"), independentState(prefs, bootstrapExpiresAtMs))
      assertControl(prefs, previous.getDouble("expires"), this)
      report(current.put("phase", "verify").put("seedPid", previous.getInt("pid")).put("bootstrapExpiresAtMs", bootstrapExpiresAtMs))
    }

  private fun assertTargetProcess() {
    assertTrue(BuildConfig.DEBUG)
    assertTrue(context.applicationContext is NodeApp)
    assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
    assertEquals(context.packageName, Application.getProcessName())
    assertEquals(context.applicationInfo.uid, Process.myUid())
    assertEquals(source, BuildConfig.GIT_COMMIT)
    for (type in listOf(NodeApp::class.java, SecurePrefs::class.java, GatewayRegistryStore::class.java, CloudflareAccessSessionStore::class.java)) {
      assertSame(type, Class.forName(type.name, false, context.classLoader))
    }
  }

  private fun identity(prefs: SecurePrefs): JSONObject {
    val apk = digest(File(context.applicationInfo.sourceDir))
    assertEquals(arguments.getString("restartApkSha256"), apk)
    val signer = PackageInfoCompat.getSignatures(context.packageManager, context.packageName).single()
    return JSONObject()
      .put("nonce", nonce)
      .put("source", source)
      .put("pid", Process.myPid())
      .put("uid", Process.myUid())
      .put("package", context.packageName)
      .put("process", Application.getProcessName())
      .put("apk", apk)
      .put("signer", digest(signer.toByteArray()))
      .put("storage", digest(context.dataDir.canonicalPath.toByteArray()))
      .put("instance", digest(prefs.instanceId.value.toByteArray()))
  }

  private fun independentState(
    prefs: SecurePrefs,
    bootstrapExpiresAtMs: Long,
  ): String {
    assertTrue(bootstrapExpiresAtMs > System.currentTimeMillis())
    val registry = prefs.gatewayRegistry
    assertEquals(
      setOf(fresh.stableId, legacy.stableId),
      registry.entries.value
        .map { it.stableId }
        .toSet(),
    )
    assertEquals(legacy.stableId, registry.activeStableId.value)
    assertEquals(listOf(legacy.stableId), registry.connectedStableIds.value)
    assertEquals("Access restart fixture", prefs.displayName.value)
    val rawIdentity = checkNotNull(prefs.getString("device.identity"))
    val device = DeviceIdentityStore.withPrefs(context, prefs).loadOrCreate().deviceId
    val state = mutableListOf(checkNotNull(prefs.getString(GatewayRegistryStore.STORAGE_KEY)), rawIdentity, prefs.instanceId.value, prefs.displayName.value)
    for (entry in profiles) {
      val saved = registry.entries.value.single { it.stableId == entry.stableId }
      assertEquals(entry.host, saved.host)
      assertEquals(443, saved.port)
      assertTrue(saved.tls)
      assertEquals(entry.contextPath, saved.contextPath)
      assertEquals(CONNECTED_AT, saved.lastConnectedAtMs)
      assertEquals(if (entry == fresh) origin.uri.toString() else null, saved.accessOrigin)
      val credentials = prefs.loadGatewayCredentials(entry.stableId)
      assertEquals("restart-gateway-token", credentials.token)
      assertEquals("restart-bootstrap-token", credentials.bootstrapToken)
      assertEquals("restart-password", credentials.password)
      assertEquals(if (entry == fresh) bootstrapExpiresAtMs else null, credentials.bootstrapExpiresAtMs)
      val headers = prefs.loadGatewayCustomHeaders(entry.stableId)
      assertEquals(mapOf("X-Existing-Ingress" to "restart-header"), headers)
      assertEquals("a".repeat(64), prefs.loadGatewayTlsFingerprint(entry.stableId))
      val auth = checkNotNull(DeviceAuthStore(prefs).loadEntry(entry.stableId, device, "operator"))
      assertEquals("restart-device-token", auth.token)
      assertEquals(listOf("operator.read"), auth.scopes)
      assertTrue(auth.updatedAtMs > 0)
      state += listOf(credentials.toString(), headers.toString(), auth.toString(), checkNotNull(prefs.loadGatewayTlsFingerprint(entry.stableId)))
    }
    return digest(JSONArray(state).toString().toByteArray())
  }

  private fun assertControl(
    prefs: SecurePrefs,
    expires: Double,
    scope: CoroutineScope,
  ) {
    val store = CloudflareAccessSessionStore(scope, CloudflareAccessSessionStore.Persistence.securePrefs(prefs), retireTransports = {})
    val control = checkNotNull(store.snapshot(controlOrigin)).session
    assertEquals("untouched-control", control.subject)
    assertEquals(expires, control.expiresAt, 0.0)
    assertTrue(checkNotNull(control.authorizationHeader(controlOrigin.uri.toString())).isNotEmpty())
  }

  private fun profile(
    endpoint: GatewayEndpoint,
    name: String,
  ): JSONObject =
    JSONObject()
      .put("stableId", endpoint.stableId)
      .put("kind", "manual")
      .put("name", name)
      .put("host", endpoint.host)
      .put("port", 443)
      .put("tls", true)
      .put("lastConnectedAtMs", CONNECTED_AT)
      .put("contextPath", endpoint.contextPath)

  private fun session(
    origin: CloudflareAccessOrigin,
    subject: String,
    expires: Double,
  ): CloudflareAccessSession {
    val application = CloudflareAccessApplication(origin, URI("https://example.cloudflareaccess.com"), "restart-test")
    val encoder = Base64.getUrlEncoder().withoutPadding()

    fun encode(value: String) = encoder.encodeToString(value.toByteArray())
    val input =
      encode("""{"alg":"RS256","kid":"restart-test"}""") + "." +
        encode("""{"iss":"${application.issuer}","aud":["restart-test"],"type":"app","sub":"$subject","exp":$expires}""")
    val key = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    val signature =
      Signature
        .getInstance("SHA256withRSA")
        .apply {
          initSign(key.private)
          update(input.toByteArray())
        }.sign()
    return CloudflareAccessSession(application, subject, expires, "$input.${encoder.encodeToString(signature)}")
  }

  private fun report(receipt: JSONObject) {
    instrumentation.addResults(Bundle().apply { putString("accessRestartReceipt", receipt.toString()) })
  }

  private fun digest(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }

  private fun digest(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(8192)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  companion object {
    private const val CONNECTED_AT = 1700000000123L
    private const val SIGNED_OUT = "This host’s Access session is signed out. Sign in to reconnect gateways using it."
  }
}
