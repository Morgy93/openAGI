package sh.openagi.mobile.voice

import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetQuestionChat
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class VoiceStateMachineTest {
    @Test fun releaseBeforeReadyNeverRecords() {
        val state = VoiceStateMachine()
        state.start(false, true)
        assertTrue(state.release().isEmpty())
        assertTrue(state.ready().isEmpty())
        assertFalse(state.recording)
        assertEquals(listOf(VoiceEffect.BARGE, VoiceEffect.START_CAPTURE), state.press())
    }
    @Test fun releaseStopsCaptureAndCommitsOnce() {
        val state = VoiceStateMachine()
        state.start(false, true)
        assertEquals(listOf(VoiceEffect.START_CAPTURE), state.ready())
        assertTrue(state.ready().isEmpty())
        assertEquals(listOf(VoiceEffect.STOP_CAPTURE, VoiceEffect.COMMIT), state.release())
        assertTrue(state.release().isEmpty())
    }
    @Test fun cancelledGestureDoesNotCommit() {
        val state = VoiceStateMachine()
        state.start(false, true)
        state.ready()
        assertEquals(listOf(VoiceEffect.STOP_CAPTURE, VoiceEffect.CANCEL), state.release(false))
    }
    @Test fun handsFreeCapturesUntilDisabledWithoutCommit() {
        val state = VoiceStateMachine()
        state.start(true, false)
        assertEquals(listOf(VoiceEffect.START_CAPTURE), state.ready())
        assertTrue(state.press().isEmpty())
        assertTrue(state.release().isEmpty())
        assertEquals(listOf(VoiceEffect.STOP_CAPTURE), state.mode(false))
        assertEquals(listOf(VoiceEffect.START_CAPTURE), state.mode(true))
        assertEquals(listOf(VoiceEffect.STOP_CAPTURE), state.stop())
        assertEquals(VoicePhase.IDLE, state.phase)
        assertFalse(state.handsFree)
    }
    @Test fun modeChangesDuringConnectApplyWhenReady() {
        val state = VoiceStateMachine()
        state.start(false, true)
        assertTrue(state.mode(true).isEmpty())
        assertTrue(state.mode(false).isEmpty())
        assertTrue(state.ready().isEmpty())
    }
    @Test fun stoppedSessionIgnoresLateReady() {
        val state = VoiceStateMachine()
        state.start(true, false)
        state.stop()
        assertTrue(state.ready().isEmpty())
        assertFalse(state.recording)
    }
}

class VoiceFramesTest {
    @Test fun startEscapesFocusAndCarriesNoCredentials() {
        val encoded = VoiceFrames.start(false, VoiceFocus(threadKey = "thread:\"one", questionId = "q1", prRef = "org/repo#42"))
        val frame = VoiceFrames.decode(encoded)!!
        assertEquals("start", VoiceFrames.field(frame, "type"))
        assertEquals("mic", VoiceFrames.field(frame, "gesture"))
        assertEquals("ptt", VoiceFrames.field(frame, "mode"))
        val focus = frame["focus"]!!.jsonObject
        assertEquals("thread:\"one", focus["threadKey"]!!.jsonPrimitive.content)
        assertEquals("q1", focus["questionId"]!!.jsonPrimitive.content)
        assertFalse(encoded.contains("token"))
        assertFalse(focus.containsKey("actionId"))
    }
    @Test fun emptyContextClearsTarget() {
        val focus = VoiceFrames.decode(VoiceFrames.context(VoiceFocus()))!!["focus"]!!.jsonObject
        assertEquals(setOf("view"), focus.keys)
    }
    @Test fun groupedQuestionFocusIncludesThreadAndQuestion() {
        for (question in listOf(
            FleetQuestion(id = "group", threadKeys = listOf("codex:first", "codex:second")),
            FleetQuestion(id = "group", chats = listOf(FleetQuestionChat(), FleetQuestionChat(threadKey = "codex:first"))),
            FleetQuestion(id = "group", threadKey = "codex:first", threadKeys = listOf("codex:second")),
        )) {
            val focus = VoiceFrames.decode(VoiceFrames.context(VoiceFocus.supervisor(question, null, null)))!!["focus"]!!.jsonObject
            assertEquals("codex:first", focus["threadKey"]!!.jsonPrimitive.content)
            assertEquals("group", focus["questionId"]!!.jsonPrimitive.content)
        }
    }
    @Test fun actionAndFixContextRoundTrip() {
        val focus = VoiceFrames.decode(VoiceFrames.context(VoiceFocus(actionId = "a1", fixId = "f1", suggestionId = "s1")))!!["focus"]!!.jsonObject
        assertEquals("a1", focus["actionId"]!!.jsonPrimitive.content)
        assertEquals("f1", focus["fixId"]!!.jsonPrimitive.content)
        assertEquals("s1", focus["suggestionId"]!!.jsonPrimitive.content)
    }
    @Test fun controlsMatchHubProtocol() {
        assertEquals("handsfree", VoiceFrames.field(VoiceFrames.decode(VoiceFrames.start(true, VoiceFocus()))!!, "mode"))
        assertEquals("true", VoiceFrames.field(VoiceFrames.decode(VoiceFrames.mode(true))!!, "handsFree"))
        assertEquals("0", VoiceFrames.field(VoiceFrames.decode(VoiceFrames.control("barge", -1))!!, "playedMs"))
        assertEquals("{\"type\":\"commit\"}", VoiceFrames.control("commit"))
        assertEquals("{\"type\":\"stop\"}", VoiceFrames.control("stop"))
        val playback = VoiceFrames.decode(VoiceFrames.playback("item1", 125.5))!!
        assertEquals(setOf("type", "itemId", "playedMs"), playback.keys)
        assertEquals("playback", VoiceFrames.field(playback, "type"))
        assertEquals("item1", VoiceFrames.field(playback, "itemId"))
        assertEquals("125.5", VoiceFrames.field(playback, "playedMs"))
    }
    @Test fun malformedAndFutureEventsAreSafe() {
        assertNull(VoiceFrames.decode("not json"))
        assertNull(VoiceFrames.decode("[]"))
        assertEquals("future", VoiceFrames.field(VoiceFrames.decode("""{"type":"future","newField":1}""")!!, "type"))
        assertNull(VoiceFrames.field(VoiceFrames.decode("""{"type":{}}""")!!, "type"))
    }
}

class VoiceSessionTest {
    private val server = MockWebServer()
    private val events = LinkedBlockingQueue<String>()
    private val binary = LinkedBlockingQueue<ByteString>()
    private val peers = LinkedBlockingQueue<WebSocket>()
    private val allPeers = CopyOnWriteArrayList<WebSocket>()
    private val peerEnded = CountDownLatch(1)
    private val audio = FakeAudio()
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build()
    private var session: VoiceSession? = null

    private class FakeAudio : VoiceAudioIO {
        @Volatile var recording = false
        @Volatile var onAudio: ((ByteArray) -> Unit)? = null
        @Volatile var onError: (() -> Unit)? = null
        @Volatile var playbackError: (() -> Unit)? = null
        val completions = LinkedBlockingQueue<() -> Unit>()
        val durations = LinkedBlockingQueue<Double>()
        var barges = 0
        override fun startCapture(onAudio: (ByteArray) -> Unit, onError: () -> Unit) { recording = true; this.onAudio = onAudio; this.onError = onError }
        override fun stopCapture() { recording = false }
        override fun play(pcm: ByteArray, onError: () -> Unit): Boolean { playbackError = onError; return true }
        override fun completeReply(audioMs: Double, onPlayed: () -> Unit) { durations.offer(audioMs); completions.offer(onPlayed) }
        override fun barge(): Long { barges++; return 125 }
        override fun close() { recording = false }
    }
    private fun connect(): VoiceSession {
        server.start()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { allPeers.add(webSocket); peers.offer(webSocket) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { peerEnded.countDown() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { peerEnded.countDown() }
            override fun onMessage(webSocket: WebSocket, text: String) { events.offer(text) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { binary.offer(bytes) }
        }))
        return VoiceSession(server.url("/").toString(), "a".repeat(43), audio, client, enforceAllowlist = false).also { session = it }
    }
    private fun event() = events.poll(3, TimeUnit.SECONDS) ?: error("Missing control frame")
    private fun peer() = peers.poll(3, TimeUnit.SECONDS) ?: error("Missing connection")
    private fun await(predicate: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!predicate() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue("Voice state did not arrive", predicate())
    }
    @After fun cleanup() {
        session?.close()
        allPeers.forEach { it.close(1000, null) }
        if (allPeers.isNotEmpty()) assertTrue("Mock peer did not close", peerEnded.await(3, TimeUnit.SECONDS))
        server.shutdown()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdownNow()
    }
    @Test fun authenticatesAndStreamsOnlyAfterReady() {
        val voice = connect()
        voice.setFocus(VoiceFocus(threadKey = "thread1"))
        voice.press()
        val ws = peer()
        val start = VoiceFrames.decode(event())!!
        assertEquals("start", VoiceFrames.field(start, "type"))
        assertEquals("thread1", start["focus"]!!.jsonObject["threadKey"]!!.jsonPrimitive.content)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/nodes/voice?rate=24000&mode=ptt", request.path)
        assertEquals("openagi-voice, " + "a".repeat(43), request.getHeader("Sec-WebSocket-Protocol"))
        assertNull(request.getHeader("Authorization"))
        assertFalse(audio.recording)
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        val pcm = byteArrayOf(0, 1, 0, 2)
        audio.onAudio!!(pcm)
        assertEquals(pcm.toByteString(), binary.poll(3, TimeUnit.SECONDS))
        voice.release()
        assertEquals(VoiceFrames.control("commit"), event())
        assertFalse(audio.recording)
    }
    @Test fun releaseBeforeReadyNeverCommitsEmptyTurn() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        voice.release()
        ws.send("""{"type":"ready"}""")
        await { voice.status.value.phase == VoicePhase.READY }
        assertFalse(audio.recording)
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        voice.press()
        assertEquals(VoiceFrames.control("barge", 125), event())
        assertTrue(audio.recording)
    }
    @Test fun cancelledHoldClearsTurnAndKeepsConnectionReady() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        val oldAudio = audio.onAudio!!
        voice.release(false)
        assertEquals(VoiceFrames.control("cancel"), event())
        assertEquals(VoicePhase.READY, voice.status.value.phase)
        assertFalse(audio.recording)
        oldAudio(byteArrayOf(0, 1))
        assertNull(binary.poll(100, TimeUnit.MILLISECONDS))
        voice.release(false)
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        voice.press()
        assertEquals(VoiceFrames.control("barge", 125), event())
        assertTrue(audio.recording)
        voice.release()
        assertEquals(VoiceFrames.control("commit"), event())
        assertNull(peers.poll(100, TimeUnit.MILLISECONDS))
    }
    @Test fun cancelledHoldBeforeReadyDoesNotCloseOrRecordLater() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        voice.release(false)
        ws.send("""{"type":"ready"}""")
        await { voice.status.value.phase == VoicePhase.READY }
        assertFalse(audio.recording)
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        voice.press()
        assertEquals(VoiceFrames.control("barge", 125), event())
        assertTrue(audio.recording)
    }
    @Test fun playbackWorkerErrorEndsSessionWithPlaybackMessage() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send(byteArrayOf(0, 1).toByteString())
        await { audio.playbackError != null }
        audio.playbackError!!()
        assertEquals(VoicePhase.IDLE, voice.status.value.phase)
        assertEquals("Reply playback failed. Start voice again.", voice.status.value.message)
        assertFalse(audio.recording)
    }
    @Test fun stalePlaybackErrorDoesNotEndNewPlayback() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send(byteArrayOf(0, 1).toByteString())
        await { audio.playbackError != null }
        val oldError = audio.playbackError!!
        ws.send("""{"type":"speech_started"}""")
        assertEquals(VoiceFrames.control("barge", 125), event())
        oldError()
        assertEquals(VoicePhase.READY, voice.status.value.phase)
    }
    @Test fun transcriptsAndHandsFreeBargeFollowHubEvents() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        assertTrue(event().contains("handsfree"))
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send("""{"type":"transcript","role":"owner","text":"Fix this"}""")
        ws.send("""{"type":"reply.delta","text":"I can "}""")
        ws.send("""{"type":"reply.delta","text":"help"}""")
        await { voice.status.value.replyText == "I can help" }
        assertEquals("Fix this", voice.status.value.ownerText)
        ws.send("""{"type":"speech_started"}""")
        assertEquals(VoiceFrames.control("barge", 125), event())
        assertEquals(1, audio.barges)
        voice.handsFree(false)
        assertEquals(VoiceFrames.mode(false), event())
        assertFalse(audio.recording)
        assertEquals(VoicePhase.IDLE, voice.status.value.phase)
    }
    @Test fun contextChangeAndEndReleaseAudio() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        val focus = VoiceFocus(threadKey = "thread2", questionId = "q2", actionId = "a2")
        voice.setFocus(focus)
        assertEquals(VoiceFrames.context(focus), event())
        ws.send("""{"type":"end","reason":"Voice cap reached."}""")
        await { voice.status.value.phase == VoicePhase.IDLE && voice.status.value.message == "Voice cap reached." }
        assertFalse(audio.recording)
        assertEquals("Voice cap reached.", voice.status.value.message)
    }
    @Test fun disabledHubShowsActionableCopy() {
        server.start()
        server.enqueue(MockResponse().setResponseCode(404))
        val voice = VoiceSession(server.url("/").toString(), "a".repeat(43), audio, client, enforceAllowlist = false).also { session = it }
        voice.press()
        await { voice.status.value.message?.contains("Voice is off") == true }
        assertFalse(audio.recording)
        assertEquals(VoicePhase.IDLE, voice.status.value.phase)
    }
    @Test fun revokedPhoneNeverRecords() {
        server.start()
        server.enqueue(MockResponse().setResponseCode(403))
        val voice = VoiceSession(server.url("/").toString(), "a".repeat(43), audio, client, enforceAllowlist = false).also { session = it }
        voice.handsFree(true)
        await { voice.status.value.message?.contains("Re-pair") == true }
        assertFalse(voice.status.value.handsFree)
        assertFalse(audio.recording)
    }
    @Test fun releasedCaptureCannotUploadOrFailLater() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        val oldAudio = audio.onAudio!!
        val oldError = audio.onError!!
        voice.release()
        assertEquals(VoiceFrames.control("commit"), event())
        voice.press()
        assertEquals(VoiceFrames.control("barge", 125), event())
        oldAudio(byteArrayOf(0, 1))
        oldError()
        assertNull(binary.poll(100, TimeUnit.MILLISECONDS))
        assertTrue(audio.recording)
        assertEquals(VoicePhase.READY, voice.status.value.phase)
    }
    @Test fun invalidTokenCannotEnterHeaders() {
        server.start()
        val invalid = VoiceSession(server.url("/").toString(), "bad\r\nheader", audio, client, enforceAllowlist = false).also { session = it }
        invalid.press()
        assertEquals(VoicePhase.IDLE, invalid.status.value.phase)
        assertFalse(audio.recording)
        assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
    }

    @Test fun playbackAcknowledgedOnlyAfterPlayerFinishes() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        voice.release()
        event()
        ws.send(byteArrayOf(0, 1).toByteString())
        ws.send("""{"type":"reply.done","text":"Say yes 42","itemId":"readback1","audioMs":125.5}""")
        val complete = audio.completions.poll(3, TimeUnit.SECONDS)!!
        assertEquals(125.5, audio.durations.poll()!!, 0.0)
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        complete()
        assertEquals(VoiceFrames.playback("readback1", 125.5), event())
        voice.press()
        assertTrue(audio.recording)
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        ws.send("""{"type":"speech_started"}""")
        ws.send("""{"type":"transcript","role":"owner","text":"yes 42"}""")
        await { voice.status.value.ownerText == "yes 42" }
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
    }

    @Test fun bargeCancelsPlaybackAcknowledgementEvenAfterHubAllowsNewAudio() {
        val voice = connect()
        voice.press()
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        voice.release()
        event()
        ws.send(byteArrayOf(0, 1).toByteString())
        ws.send("""{"type":"reply.done","text":"Say yes 42","itemId":"readback1","audioMs":500}""")
        val complete = audio.completions.poll(3, TimeUnit.SECONDS)!!
        voice.press()
        assertEquals(VoiceFrames.control("barge", 125), event())
        ws.send("""{"type":"barged"}""")
        ws.send("""{"type":"reply.delta","text":"Next reply"}""")
        await { voice.status.value.replyText == "Next reply" }
        complete()
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
    }

    @Test fun stopCancelsPendingPlaybackAcknowledgement() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send("""{"type":"reply.done","text":"Readback","itemId":"item1","audioMs":500}""")
        val complete = audio.completions.poll(3, TimeUnit.SECONDS)!!
        voice.stop()
        assertEquals(VoiceFrames.control("stop"), event())
        complete()
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
    }

    @Test fun earlierPlaybackDoesNotSuppressBargeForNextReply() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send(byteArrayOf(0, 1).toByteString())
        ws.send("""{"type":"reply.done","text":"First","itemId":"first","audioMs":500}""")
        val complete = audio.completions.poll(3, TimeUnit.SECONDS)!!
        ws.send(byteArrayOf(0, 1).toByteString())
        ws.send("""{"type":"reply.done","text":"Second","itemId":"second","audioMs":250}""")
        val second = audio.completions.poll(3, TimeUnit.SECONDS)!!
        complete()
        assertEquals(VoiceFrames.playback("first", 500.0), event())
        ws.send("""{"type":"speech_started"}""")
        assertEquals(VoiceFrames.control("barge", 125), event())
        second()
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
    }

    @Test fun interruptedDoneAndTextOnlyDoneDoNotScheduleAcknowledgements() {
        val voice = connect()
        voice.handsFree(true)
        val ws = peer()
        event()
        ws.send("""{"type":"ready"}""")
        await { audio.recording }
        ws.send("""{"type":"reply.done","text":"Text only","itemId":null,"audioMs":0}""")
        await { voice.status.value.replyText == "Text only" }
        assertNull(audio.completions.poll(100, TimeUnit.MILLISECONDS))
        ws.send("""{"type":"speech_started"}""")
        assertEquals(VoiceFrames.control("barge", 125), event())
        ws.send("""{"type":"reply.done","text":"Interrupted","itemId":"old","audioMs":500}""")
        await { voice.status.value.replyText == "Interrupted" }
        assertNull(audio.completions.poll(100, TimeUnit.MILLISECONDS))
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
    }
}
