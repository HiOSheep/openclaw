package ai.openclaw.app.gateway

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.io.IOException
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val WIRE_TIMEOUT_MS = 8_000L
private const val MEDIA_PATH = "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=fixture"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayIngressWireTest {
  @Test
  fun pinnedSocketsAndMediaKeepHeadersAndRejectForeignAuthorityAndRedirects() =
    withFixture { fixture ->
      val foreign =
        MockWebServer().apply {
          useHttps(gatewayTestTlsIdentity().socketFactory, false)
          start(InetAddress.getByName("127.0.0.1"), 0)
        }
      try {
        fixture.prepare()
        val media = checkNotNull(fixture.load(fixture.operator, fixture.primary))
        assertArrayEquals(byteArrayOf(1, 2, 3), media.bytes)
        val protected = fixture.requests.filter { it.getHeader("Upgrade") == "websocket" || it.path == fixture.primary.contextPath + MEDIA_PATH }
        assertEquals(3, protected.size)
        protected.forEach {
          assertNotNull(it.handshake)
          assertEquals(fixture.acceptedToken.get(), it.getHeader("Cf-Access-Token"))
          assertEquals("preserved", it.getHeader("X-Existing-Ingress"))
          assertNull(it.getHeader("Authorization"))
          assertNull(it.getHeader("Cookie"))
        }
        assertEquals(setOf("node", "operator"), fixture.peers.map { it.role }.toSet())
        assertTrue(fixture.gatewayTokens.all { it == "gateway-pairing-token" })
        val wrongOrigin = Request.Builder().url("https://127.0.0.1:${foreign.port}/leak").build()
        assertTrue(
          runCatching {
            val call = media.client.newCall(wrongOrigin)
            fixture.calls.add(call)
            fixture.bounded { call.execute().close() }
          }.exceptionOrNull() is GatewayExternalAuthorizationException,
        )
        fixture.redirect.set("https://127.0.0.1:${foreign.port}/leak")
        assertNull(fixture.load(fixture.operator, fixture.primary))
        assertEquals(0, foreign.requestCount)
        assertEquals(2, fixture.requests.count { it.path == fixture.primary.contextPath + MEDIA_PATH })
      } finally {
        fixture.bounded { foreign.shutdown() }
      }
    }

  @Test
  fun retirementJoinsHeldTlsMediaAndPreventsDelayedUpgradeAndRangeRequests() {
    for (action in listOf("signOut", "forget", "replaceAccount")) {
      withFixture { fixture ->
        fixture.prepare()
        fixture.connectFleet()
        val secondary = fixture.secondary(fixture.managed)
        val ordinary = fixture.secondary(fixture.ordinary)
        assertEquals(fixture.origin, fixture.owner.managedOrigin(fixture.primary))
        assertEquals(fixture.origin, fixture.owner.managedOrigin(fixture.managed))
        assertNull(fixture.owner.managedOrigin(fixture.ordinary))
        val primaryCapability = checkNotNull(fixture.load(fixture.operator, fixture.primary))
        val secondaryCapability = checkNotNull(fixture.load(secondary, fixture.managed))
        fixture.assertOrdinaryWorks(ordinary)
        val oldToken = fixture.acceptedToken.get()
        val oldPeers = fixture.peers.filter { it.token == oldToken }
        assertEquals(3, oldPeers.size)
        val controlPeers = fixture.peers.filter { it.path == fixture.ordinary.contextPath }
        assertEquals(1, controlPeers.size)
        fixture.holdMedia.set(true)
        val primaryRead = fixture.holdRead(primaryCapability, fixture.primary)
        val secondaryRead = fixture.holdRead(secondaryCapability, fixture.managed)
        fixture.holdProbe.set(true)
        fixture.runtime.refreshGatewayConnection()
        withTimeout(WIRE_TIMEOUT_MS) { fixture.probeStarted.await() }
        val preparing = checkNotNull(ReflectionHelpers.getField<Job?>(fixture.runtime, "ingressPreparation"))
        // The queued refresh has not drained the active generation; the action below must do it.
        assertTrue(fixture.node.isReady())
        assertTrue(fixture.operator.isReady())
        assertTrue(secondary.isReady())
        assertFalse(primaryRead.call.isCanceled())
        assertFalse(secondaryRead.call.isCanceled())
        assertTrue(oldPeers.none { it.closed.isCompleted })
        val oldUpgradeCount = fixture.oldUpgrades(oldToken)
        when (action) {
          "forget" -> {
            assertTrue(fixture.bounded { fixture.runtime.forgetGateway(fixture.primary.stableId) })
            fixture.assertRetired(listOf(fixture.node, fixture.operator), oldPeers.filter { it.path == fixture.primary.contextPath }, listOf(primaryRead))
            assertTrue(secondary.isReady())
            assertFalse(secondaryRead.call.isCanceled())
            assertTrue(oldPeers.filter { it.path == fixture.managed.contextPath }.none { it.closed.isCompleted })
            assertNotNull(fixture.persistedGrant())
            assertNull(fixture.prefs.loadGatewayCredentials(fixture.primary.stableId).token)
            assertTrue(fixture.prefs.loadGatewayCustomHeaders(fixture.primary.stableId).isEmpty())
            fixture.assertPairing(fixture.managed)
            assertEquals("{}", fixture.bounded { secondary.requestForEndpoint(fixture.managed.stableId, "health", null) })
            fixture.assertOrdinaryWorks(ordinary)
            // The last managed profile owns origin retirement; an ordinary same-origin profile does not.
            assertTrue(fixture.bounded { fixture.runtime.forgetGateway(fixture.managed.stableId) })
            fixture.assertRetired(listOf(secondary), oldPeers.filter { it.path == fixture.managed.contextPath }, listOf(secondaryRead))
            assertNull(fixture.persistedGrant())
          }

          "replaceAccount" -> {
            fixture.bounded { fixture.replaceAccount() }
            fixture.assertRetired(listOf(fixture.node, fixture.operator, secondary), oldPeers, listOf(primaryRead, secondaryRead))
            fixture.assertPairing(fixture.primary)
            fixture.assertPairing(fixture.managed)
            assertNotNull(fixture.persistedGrant())
          }

          else -> {
            fixture.bounded { checkNotNull(fixture.owner.signOut(fixture.primary.stableId)).await() }
            fixture.assertRetired(listOf(fixture.node, fixture.operator, secondary), oldPeers, listOf(primaryRead, secondaryRead))
            fixture.assertPairing(fixture.primary)
            fixture.assertPairing(fixture.managed)
            assertNull(fixture.persistedGrant())
          }
        }
        assertTrue(controlPeers.none { it.closed.isCompleted })
        fixture.assertOrdinaryWorks(ordinary)
        if (action == "replaceAccount") {
          assertFalse(
            fixture.runtime.gatewayConnectionDisplay.value.problem
              ?.code == "EXTERNAL_AUTH_REQUIRED",
          )
        }
        fixture.releaseProbe.countDown()
        withTimeout(WIRE_TIMEOUT_MS) { preparing.join() }
        // A terminal rejection proves the released old response never scheduled a later socket owner.
        if (action == "replaceAccount") {
          assertEquals(
            "EXTERNAL_AUTH_REQUIRED",
            fixture.runtime.gatewayConnectionDisplay.value.problem
              ?.code,
          )
        } else {
          assertTrue(preparing.isCancelled)
        }
        assertNull(ReflectionHelpers.getField<Any?>(fixture.node, "desired"))
        assertNull(ReflectionHelpers.getField<Any?>(fixture.operator, "desired"))
        assertFalse(fixture.probeExpired.get())
        assertEquals(oldUpgradeCount, fixture.oldUpgrades(oldToken))
        fixture.assertLateDenied(primaryRead)
        fixture.assertLateDenied(secondaryRead)
        if (action == "replaceAccount") {
          fixture.holdMedia.set(false)
          fixture.connectPrimary()
          fixture.connectFleet()
          assertArrayEquals(byteArrayOf(1, 2, 3), checkNotNull(fixture.load(fixture.operator, fixture.primary)).bytes)
          val fresh = fixture.peers.filter { it.token == fixture.acceptedToken.get() }
          assertEquals(3, fresh.size)
          assertTrue(fresh.none { it.closed.isCompleted })
          assertEquals(oldUpgradeCount, fixture.oldUpgrades(oldToken))
        }
      }
    }
  }

  private fun withFixture(block: suspend (WireFixture) -> Unit) {
    val fixture = WireFixture()
    val failures = mutableListOf<Throwable>()
    try {
      drainWithMainLooper { block(fixture) }
    } catch (error: Throwable) {
      failures.add(error)
    } finally {
      runCatching { fixture.close() }.exceptionOrNull()?.let(failures::add)
    }
    MultipleFailureException.assertEmpty(failures)
  }

  private class Peer(
    val path: String?,
    val token: String?,
  ) {
    @Volatile var role: String? = null
    val closed = CompletableDeferred<Unit>()
  }

  private class HeldRead(
    val capability: GatewayLoadedMedia.Buffered,
    val request: Request,
    val call: Call,
    val pending: Deferred<Result<Byte>>,
  )

  private class WireFixture {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val requests = ConcurrentLinkedQueue<RecordedRequest>()
    val peers = ConcurrentLinkedQueue<Peer>()
    val gatewayTokens = ConcurrentLinkedQueue<String>()
    val holdProbe = AtomicBoolean(false)
    val holdMedia = AtomicBoolean(false)
    val redirect = AtomicReference<String?>()
    val probeStarted = CompletableDeferred<Unit>()
    val releaseProbe = CountDownLatch(1)
    val probeExpired = AtomicBoolean(false)
    val calls = ConcurrentLinkedQueue<Call>()
    private val responses = ConcurrentLinkedQueue<Response>()
    private val identity = gatewayTestTlsIdentity()
    val server =
      MockWebServer().apply {
        useHttps(identity.socketFactory, false)
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    val primary = GatewayEndpoint.manual("127.0.0.1", server.port, true, "/primary")
    val managed = GatewayEndpoint.manual("127.0.0.1", server.port, true, "/managed-secondary")
    val ordinary = GatewayEndpoint.manual("127.0.0.1", server.port, true, "/ordinary")
    private val application = CloudflareAccessTestTokens.application.copy(origin = CloudflareAccessOrigin.from(url("/")))
    val origin get() = application.origin
    private var nextSession = newSession("wire-first")
    val acceptedToken = AtomicReference(checkNotNull(nextSession.authorizationHeader(url("/"))))
    private val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("access-wire-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs)
    private val startupJobs =
      ReflectionHelpers
        .getField<CoroutineScope>(runtime, "scope")
        .coroutineContext.job.children
        .toList()
    val owner = ReflectionHelpers.getField<Lazy<GatewayIngressController>>(runtime, "gatewayIngress\$delegate").value
    val node = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
    val operator = ReflectionHelpers.getField<GatewaySession>(runtime, "operatorSession")
    private val store = ReflectionHelpers.getField<CloudflareAccessSessionStore>(owner, "store")
    private val persistence = CloudflareAccessSessionStore.Persistence.securePrefs(prefs)

    init {
      server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            requests.add(request)
            if (request.method == "HEAD") return MockResponse().setHeader("Cf-Access-Metadata", CloudflareAccessTestTokens.metadata("127.0.0.1"))
            val ordinaryRequest = request.path.orEmpty().startsWith(ordinary.contextPath)
            val accepted =
              request.getHeader("Cf-Access-Token") == acceptedToken.get() ||
                (ordinaryRequest && request.getHeader("X-Existing-Ingress") == "preserved" && request.getHeader("Cf-Access-Token") == null)
            if (request.getHeader("Upgrade").equals("websocket", true) && accepted) return upgrade(request)
            if (request.path.orEmpty().contains(MEDIA_PATH) && accepted) {
              redirect.get()?.let { return MockResponse().setResponseCode(302).setHeader("Location", it) }
              return MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(byteArrayOf(1, 2, 3))).apply {
                if (holdMedia.get() && !ordinaryRequest) throttleBody(1, 1, TimeUnit.DAYS)
              }
            }
            val response =
              if (accepted) {
                MockResponse()
              } else {
                MockResponse()
                  .setResponseCode(302)
                  .setHeader("WWW-Authenticate", "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/\"")
              }
            // Capture the old successful verdict before a replacement changes server credentials.
            if (request.path == primary.contextPath && request.getHeader("Cf-Access-Token") != null && holdProbe.compareAndSet(true, false)) {
              probeStarted.complete(Unit)
              if (!releaseProbe.await(WIRE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                probeExpired.set(true)
                return MockResponse().setResponseCode(500)
              }
            }
            return response
          }
        }
    }

    private fun newSession(subject: String): CloudflareAccessSession {
      val expires = System.currentTimeMillis() / 1000.0 + 3600
      return CloudflareAccessSession(application, subject, expires, CloudflareAccessTestTokens.token(CloudflareAccessTestTokens.claims(subject, expires)))
    }

    suspend fun replaceAccount() {
      nextSession = newSession("wire-replacement")
      acceptedToken.set(checkNotNull(nextSession.authorizationHeader(url("/"))))
      store.signIn(application) {}.await()
    }

    fun url(path: String): String = "https://127.0.0.1:${server.port}$path"

    fun persistedGrant(): String? = persistence.load(origin)

    suspend fun <T> bounded(operation: suspend () -> T): T {
      val task = scope.async(Dispatchers.IO) { operation() }
      try {
        return withTimeout(WIRE_TIMEOUT_MS) { task.await() }
      } finally {
        if (!task.isCompleted) task.cancel()
      }
    }

    suspend fun prepare() {
      // Isolate constructor discovery/fleet producers before seeding. Real runtime/session owners stay live.
      startupJobs.forEach { it.cancel() }
      withTimeout(WIRE_TIMEOUT_MS) { startupJobs.joinAll() }
      val clientForRoute: (GatewayEndpoint, GatewayTlsParams) -> CloudflareAccessClient = { _, params ->
        val config = checkNotNull(buildGatewayTlsConfig(params))
        val transport =
          OkHttpClient
            .Builder()
            .sslSocketFactory(config.sslSocketFactory, config.trustManager)
            .hostnameVerifier(config.hostnameVerifier)
            .followRedirects(false)
            .followSslRedirects(false)
            .cookieJar(CookieJar.NO_COOKIES)
            .cache(null)
            .build()
        CloudflareAccessClient { request, maximumBytes, timeout ->
          // Only issuer discovery is synthetic. Gateway probes use the production pinned TLS send path.
          if (request.url.host == application.issuer.host) {
            CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), CloudflareAccessTestTokens.jwks)
          } else {
            CloudflareAccessClient.send(request, maximumBytes, timeout, transport)
          }
        }
      }
      val authenticate: suspend (CloudflareAccessApplication, suspend (String) -> Unit) -> CloudflareAccessSession = { _, _ -> nextSession }
      ReflectionHelpers.setField(owner, "clientForRoute", clientForRoute)
      ReflectionHelpers.setField(store, "authenticate", authenticate)
      assertTrue(persistence.save(origin, nextSession.encode()))
      for (endpoint in listOf(primary, managed, ordinary)) {
        prefs.gatewayRegistry.upsert(
          GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, "Wire fixture", endpoint.host, endpoint.port, tls = true, contextPath = endpoint.contextPath),
        )
        prefs.saveGatewayTlsFingerprint(endpoint.stableId, identity.fingerprint)
        prefs.saveGatewayCredentials(endpoint.stableId, token = "gateway-pairing-token")
        prefs.saveGatewayCustomHeaders(endpoint.stableId, mapOf("X-Existing-Ingress" to "preserved"))
      }
      connectPrimary()
    }

    suspend fun connectPrimary() {
      runtime.connect(primary, NodeRuntime.GatewayConnectAuth("gateway-pairing-token", null, null))
      waitUntil { node.isReady() && operator.isReady() && prefs.gatewayRegistry.activeStableId.value == primary.stableId }
    }

    suspend fun connectFleet() {
      runtime.setGatewayConnectionEnabled(managed.stableId, true)
      runtime.setGatewayConnectionEnabled(ordinary.stableId, true)
      bounded {
        kotlin.coroutines.intrinsics.suspendCoroutineUninterceptedOrReturn<Any?> { continuation ->
          NodeRuntime::class.java
            .getDeclaredMethod("reconcileBackgroundGatewayFleet", java.lang.Long.TYPE, kotlin.coroutines.Continuation::class.java)
            .apply { isAccessible = true }
            .invoke(runtime, owner.admissionCheckpoint(), continuation)
        }
      }
      waitUntil { secondary(managed).isReady() && secondary(ordinary).isReady() }
      val active = checkNotNull(ReflectionHelpers.getField<Any?>(runtime, "activeGatewayConnection"))
      val fleet = ReflectionHelpers.getField<Map<String, Any>>(runtime, "secondaryOperatorSessions")
      assertEquals(origin, ReflectionHelpers.getField<CloudflareAccessOrigin?>(active, "ingressOrigin"))
      assertEquals(origin, ReflectionHelpers.getField<CloudflareAccessOrigin?>(checkNotNull(fleet[managed.stableId]), "ingressOrigin"))
      assertNull(ReflectionHelpers.getField<CloudflareAccessOrigin?>(checkNotNull(fleet[ordinary.stableId]), "ingressOrigin"))
    }

    fun secondary(endpoint: GatewayEndpoint): GatewaySession {
      val fleet = ReflectionHelpers.getField<Map<String, Any>>(runtime, "secondaryOperatorSessions")
      return ReflectionHelpers.getField(checkNotNull(fleet[endpoint.stableId]), "session")
    }

    suspend fun load(
      session: GatewaySession,
      endpoint: GatewayEndpoint,
    ): GatewayLoadedMedia.Buffered? = bounded { session.loadMediaArtifact(endpoint.stableId, "main", null, "wire-artifact", GatewayMediaKind.Image) as? GatewayLoadedMedia.Buffered }

    suspend fun holdRead(
      capability: GatewayLoadedMedia.Buffered,
      endpoint: GatewayEndpoint,
    ): HeldRead {
      val request =
        Request
          .Builder()
          .url(url(endpoint.contextPath + MEDIA_PATH))
          .apply {
            capability.headers.forEach { (name, value) -> header(name, value) }
          }.build()
      val call = capability.client.newCall(request)
      calls.add(call)
      val response = bounded { call.execute() }
      responses.add(response)
      assertEquals(
        1,
        bounded {
          response.body
            .source()
            .readByte()
            .toInt()
        },
      )
      val reading = CompletableDeferred<Unit>()
      val pending =
        scope.async(Dispatchers.IO) {
          reading.complete(Unit)
          runCatching { response.body.source().readByte() }
        }
      withTimeout(WIRE_TIMEOUT_MS) { reading.await() }
      return HeldRead(capability, request, call, pending)
    }

    suspend fun assertRetired(
      sessions: List<GatewaySession>,
      retiredPeers: List<Peer>,
      reads: List<HeldRead>,
    ) {
      reads.forEach { assertTrue(it.call.isCanceled()) }
      sessions.forEach { assertFalse(it.isReady()) }
      withTimeout(WIRE_TIMEOUT_MS) {
        retiredPeers.forEach { it.closed.await() }
        reads.forEach { assertTrue(it.pending.await().exceptionOrNull() is IOException) }
      }
    }

    fun assertPairing(endpoint: GatewayEndpoint) {
      assertEquals("gateway-pairing-token", prefs.loadGatewayCredentials(endpoint.stableId).token)
      assertEquals(mapOf("X-Existing-Ingress" to "preserved"), prefs.loadGatewayCustomHeaders(endpoint.stableId))
    }

    suspend fun assertOrdinaryWorks(session: GatewaySession) {
      assertTrue(session.isReady())
      assertArrayEquals(byteArrayOf(1, 2, 3), checkNotNull(load(session, ordinary)).bytes)
      assertPairing(ordinary)
      requests.filter { it.path.orEmpty().startsWith(ordinary.contextPath) }.forEach {
        assertNotNull(it.handshake)
        assertNull(it.getHeader("Cf-Access-Token"))
        assertEquals("preserved", it.getHeader("X-Existing-Ingress"))
      }
    }

    suspend fun assertLateDenied(read: HeldRead) {
      val before = requests.size
      val late =
        read.capability.client.newCall(
          read.request
            .newBuilder()
            .header("Range", "bytes=1-")
            .build(),
        )
      calls.add(late)
      assertTrue(runCatching { bounded { late.execute().close() } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertEquals(before, requests.size)
    }

    fun oldUpgrades(token: String): Int = requests.count { it.getHeader("Upgrade") == "websocket" && it.getHeader("Cf-Access-Token") == token }

    private suspend fun waitUntil(predicate: () -> Boolean) =
      withTimeout(WIRE_TIMEOUT_MS) {
        while (!predicate()) delay(1)
      }

    private fun upgrade(request: RecordedRequest): MockResponse {
      val peer = Peer(request.path, request.getHeader("Cf-Access-Token"))
      peers.add(peer)
      return MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onOpen(
            webSocket: WebSocket,
            response: Response,
          ) {
            webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"wire-nonce","ts":1700000000123}}""")
          }

          override fun onMessage(
            webSocket: WebSocket,
            text: String,
          ) {
            val frame = Json.parseToJsonElement(text).jsonObject
            val id = frame["id"] ?: return
            val method = frame["method"]?.jsonPrimitive?.content
            val payload =
              if (method == "connect") {
                val params = frame["params"]!!.jsonObject
                peer.role = params["role"]!!.jsonPrimitive.content
                gatewayTokens.add(params["auth"]!!.jsonObject["token"]!!.jsonPrimitive.content)
                """{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}"""
              } else if (method == "artifacts.download") {
                """{"artifact":{"type":"image","mimeType":"image/png"},"url":"$MEDIA_PATH"}"""
              } else if (method == "sessions.list") {
                """{"sessions":[]}"""
              } else if (method == "agents.list") {
                """{"defaultId":"main","agents":[]}"""
              } else {
                "{}"
              }
            webSocket.send("""{"type":"res","id":$id,"ok":true,"payload":$payload}""")
          }

          override fun onClosed(
            webSocket: WebSocket,
            code: Int,
            reason: String,
          ) {
            peer.closed.complete(Unit)
          }

          override fun onFailure(
            webSocket: WebSocket,
            error: Throwable,
            response: Response?,
          ) {
            peer.closed.complete(Unit)
          }
        },
      )
    }

    fun close() {
      val failures = mutableListOf<Throwable>()
      holdProbe.set(false)
      releaseProbe.countDown()
      calls.forEach { it.cancel() }
      responses.forEach { runCatching { it.close() }.exceptionOrNull()?.let(failures::add) }
      try {
        drainWithMainLooper {
          bounded { server.shutdown() }
          val sessions =
            listOf(node, operator) +
              ReflectionHelpers.getField<Map<String, Any>>(runtime, "secondaryOperatorSessions").values.map {
                ReflectionHelpers.getField<GatewaySession>(it, "session")
              }
          runtime.disconnect()
          withTimeout(WIRE_TIMEOUT_MS) { sessions.forEach { it.disconnectAndJoin() } }
        }
      } catch (error: Throwable) {
        failures.add(error)
      } finally {
        runCatching { closeNodeRuntimeTestFixture(runtime) }.exceptionOrNull()?.let(failures::add)
        runCatching { drainWithMainLooper { withTimeout(WIRE_TIMEOUT_MS) { scope.coroutineContext.job.cancelAndJoin() } } }.exceptionOrNull()?.let(failures::add)
      }
      if (probeExpired.get()) failures.add(AssertionError("Held probe expired instead of being released by the test"))
      MultipleFailureException.assertEmpty(failures)
    }
  }
}
