package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
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
    runBlocking {
      val fixture = WireFixture()
      val foreign =
        MockWebServer().apply {
          useHttps(gatewayTestTlsIdentity().socketFactory, false)
          start(InetAddress.getByName("127.0.0.1"), 0)
        }
      try {
        fixture.prepare()
        val node = fixture.connect("node")
        val operator = fixture.connect("operator")
        withTimeout(WIRE_TIMEOUT_MS) {
          node.second.await()
          operator.second.await()
        }
        val media = checkNotNull(fixture.load(operator.first))
        assertArrayEquals(byteArrayOf(1, 2, 3), media.bytes)
        val protected = fixture.requests.filter { it.getHeader("Upgrade") == "websocket" || it.path == MEDIA_PATH }
        assertEquals(3, protected.size)
        protected.forEach {
          assertNotNull(it.handshake)
          assertEquals(fixture.acceptedToken.get(), it.getHeader("Cf-Access-Token"))
          assertEquals("preserved", it.getHeader("X-Existing-Ingress"))
          assertNull(it.getHeader("Authorization"))
          assertNull(it.getHeader("Cookie"))
        }
        assertEquals(setOf("node", "operator"), fixture.roles.toSet())
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
        assertNull(fixture.load(operator.first))
        assertEquals(0, foreign.requestCount)
        assertEquals(2, fixture.requests.count { it.path == MEDIA_PATH })
      } finally {
        try {
          fixture.bounded { foreign.shutdown() }
        } finally {
          fixture.close()
        }
      }
    }

  @Test
  fun retirementJoinsHeldTlsMediaAndPreventsDelayedUpgradeAndRangeRequests() =
    runBlocking {
      for (action in listOf("signOut", "forget", "replaceAccount")) {
        val fixture = WireFixture()
        try {
          fixture.prepare()
          val operator = fixture.connect("operator")
          withTimeout(WIRE_TIMEOUT_MS) { operator.second.await() }
          val capability = checkNotNull(fixture.load(operator.first))
          fixture.holdMedia.set(true)
          fixture.holdProbe.set(true)
          val pendingNode = fixture.connect("node")
          withTimeout(WIRE_TIMEOUT_MS) { fixture.probeStarted.await() }
          val request =
            Request
              .Builder()
              .url(fixture.url(MEDIA_PATH))
              .apply {
                capability.headers.forEach { (name, value) -> header(name, value) }
              }.build()
          val call = capability.client.newCall(request)
          fixture.calls.add(call)
          fixture.bounded { call.execute() }.use { response ->
            assertEquals(
              1,
              fixture.bounded {
                response.body
                  .source()
                  .readByte()
                  .toInt()
              },
            )
            val reading = CompletableDeferred<Unit>()
            val pending =
              fixture.scope.async(Dispatchers.IO) {
                reading.complete(Unit)
                runCatching { response.body.source().readByte() }
              }
            withTimeout(WIRE_TIMEOUT_MS) { reading.await() }
            fixture.bounded {
              when (action) {
                "forget" -> {
                  fixture.owner.forget(fixture.endpoint.stableId)
                }

                "replaceAccount" -> {
                  fixture.holdProbe.set(false)
                  fixture.replaceAccount()
                  fixture.prepare(userInitiated = true)
                }

                else -> {
                  checkNotNull(fixture.owner.signOut(fixture.endpoint.stableId)).await()
                }
              }
              // The production retirement must cancel the Call and finish both session owners itself.
              assertTrue(call.isCanceled())
              assertTrue(operator.third.isCompleted)
              assertTrue(pendingNode.third.isCompleted)
              fixture.releaseProbe.countDown()
              assertTrue(pending.await().exceptionOrNull() is IOException)
            }
          }
          assertFalse(fixture.probeExpired.get())
          assertFalse(pendingNode.second.isCompleted)
          assertEquals(1, fixture.requests.count { it.getHeader("Upgrade") == "websocket" })
          assertEquals(2, fixture.requests.count { it.path == MEDIA_PATH })
          val before = fixture.requests.size
          val late = capability.client.newCall(request.newBuilder().header("Range", "bytes=1-").build())
          fixture.calls.add(late)
          assertTrue(runCatching { fixture.bounded { late.execute().close() } }.exceptionOrNull() is GatewayExternalAuthorizationException)
          assertEquals(before, fixture.requests.size)
          if (action != "replaceAccount") assertNull(fixture.stored.get())
        } finally {
          fixture.close()
        }
      }
    }

  private class WireFixture {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val requests = ConcurrentLinkedQueue<RecordedRequest>()
    val roles = ConcurrentLinkedQueue<String>()
    val gatewayTokens = ConcurrentLinkedQueue<String>()
    val holdProbe = AtomicBoolean(false)
    val holdMedia = AtomicBoolean(false)
    val redirect = AtomicReference<String?>()
    val probeStarted = CompletableDeferred<Unit>()
    val releaseProbe = CountDownLatch(1)
    val probeExpired = AtomicBoolean(false)
    val calls = ConcurrentLinkedQueue<Call>()
    private val identity = gatewayTestTlsIdentity()
    val server =
      MockWebServer().apply {
        useHttps(identity.socketFactory, false)
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, true)
    private val tls = GatewayTlsParams(true, identity.fingerprint, false, endpoint.stableId)
    private val application = CloudflareAccessTestTokens.application.copy(origin = CloudflareAccessOrigin.from(url("/")))
    private var nextSession = newSession("wire-first")
    val acceptedToken = AtomicReference(checkNotNull(nextSession.authorizationHeader(url("/"))))
    val stored = AtomicReference<String?>(nextSession.encode())
    private val sessions = mutableListOf<GatewaySession>()
    private val app = RuntimeEnvironment.getApplication()
    private val prefs = SecurePrefs(app, app.getSharedPreferences("access-wire-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    private val registry =
      GatewayRegistryStore(prefs).apply {
        upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, "Wire fixture", endpoint.host, endpoint.port, tls = true))
      }
    val owner =
      GatewayIngressController(
        scope,
        registry,
        CloudflareAccessSessionStore.Persistence(
          load = { stored.get() },
          save = { _, value ->
            stored.set(value)
            true
          },
          delete = {
            stored.set(null)
            true
          },
        ),
        customHeaders = { mapOf("X-Existing-Ingress" to "preserved") },
        retireTransports = { sessions.toList().forEach { it.disconnectAndJoin() } },
        clientForRoute = { _, params ->
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
            // Only the external issuer is synthetic; Gateway probes use the real pinned TLS transport.
            if (request.url.host == application.issuer.host) {
              CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), CloudflareAccessTestTokens.jwks)
            } else {
              CloudflareAccessClient.send(request, maximumBytes, timeout, transport)
            }
          }
        },
        authenticate = { _, _ -> nextSession },
      )

    init {
      server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            requests.add(request)
            if (request.getHeader("Upgrade").equals("websocket", true)) return upgrade()
            if (request.method == "HEAD") return MockResponse().setHeader("Cf-Access-Metadata", CloudflareAccessTestTokens.metadata("127.0.0.1"))
            if (request.path == MEDIA_PATH) {
              redirect.get()?.let { return MockResponse().setResponseCode(302).setHeader("Location", it) }
              return MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(byteArrayOf(1, 2, 3))).apply {
                if (holdMedia.get()) throttleBody(1, 1, TimeUnit.DAYS)
              }
            }
            val response =
              if (request.getHeader("Cf-Access-Token") == acceptedToken.get()) {
                MockResponse()
              } else {
                MockResponse()
                  .setResponseCode(302)
                  .setHeader("WWW-Authenticate", "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/\"")
              }
            // Capture the old successful verdict before a replacement changes server credentials.
            if (holdProbe.get() && request.getHeader("Cf-Access-Token") != null) {
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

    fun replaceAccount() {
      nextSession = newSession("wire-replacement")
      acceptedToken.set(checkNotNull(nextSession.authorizationHeader(url("/"))))
    }

    fun url(path: String): String = "https://127.0.0.1:${server.port}$path"

    suspend fun <T> bounded(operation: suspend () -> T): T {
      val task = scope.async(Dispatchers.IO) { operation() }
      try {
        return withTimeout(WIRE_TIMEOUT_MS) { task.await() }
      } finally {
        if (!task.isCompleted) task.cancel()
      }
    }

    suspend fun prepare(userInitiated: Boolean = false) =
      bounded {
        assertNotNull(owner.prepare(endpoint, tls, userInitiated, owner.admissionCheckpoint()) { true })
      }

    fun connect(role: String): Triple<GatewaySession, CompletableDeferred<Unit>, CompletableDeferred<Unit>> {
      val connected = CompletableDeferred<Unit>()
      val offline = CompletableDeferred<Unit>()
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = DeviceAuthStore(prefs),
          onConnected = { connected.complete(Unit) },
          onDisconnected = { if (it == "Offline") offline.complete(Unit) },
          onEvent = { _, _ -> },
          customHeadersProvider = { mapOf("X-Existing-Ingress" to "preserved") },
          ingressAuthorizationProvider = owner::authorization,
        )
      sessions.add(session)
      session.connect(
        endpoint,
        "gateway-pairing-token",
        null,
        null,
        GatewayConnectOptions(
          role,
          emptyList(),
          emptyList(),
          emptyList(),
          emptyMap(),
          GatewayClientInfo("openclaw-android-test", "Wire fixture", "test", "android", "node", "test", "android", "test"),
        ),
        tls,
      )
      return Triple(session, connected, offline)
    }

    suspend fun load(session: GatewaySession): GatewayLoadedMedia.Buffered? =
      bounded {
        session.loadMediaArtifact(endpoint.stableId, "main", null, "wire-artifact", GatewayMediaKind.Image) as? GatewayLoadedMedia.Buffered
      }

    private fun upgrade() =
      MockResponse().withWebSocketUpgrade(
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
                roles.add(params["role"]!!.jsonPrimitive.content)
                gatewayTokens.add(params["auth"]!!.jsonObject["token"]!!.jsonPrimitive.content)
                """{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}"""
              } else {
                """{"artifact":{"type":"image","mimeType":"image/png"},"url":"$MEDIA_PATH"}"""
              }
            webSocket.send("""{"type":"res","id":$id,"ok":true,"payload":$payload}""")
          }
        },
      )

    suspend fun close() {
      holdProbe.set(false)
      releaseProbe.countDown()
      calls.forEach { it.cancel() }
      sessions.forEach { it.disconnect() }
      try {
        // Closing physical I/O also releases operations that ignore coroutine cancellation.
        bounded { server.shutdown() }
      } finally {
        withTimeout(WIRE_TIMEOUT_MS) { scope.coroutineContext.job.cancelAndJoin() }
      }
      assertFalse("Held probe expired instead of being released by the test", probeExpired.get())
    }
  }
}
