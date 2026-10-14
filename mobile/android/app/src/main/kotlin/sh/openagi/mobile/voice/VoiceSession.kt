package sh.openagi.mobile.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import sh.openagi.mobile.transport.HostAllowlist
import sh.openagi.mobile.protocol.FleetAction
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetThread
import java.util.concurrent.TimeUnit

@Serializable
data class VoiceFocus(
    val view: String = "supervisor",
    val threadKey: String? = null,
    val questionId: String? = null,
    val actionId: String? = null,
    val prRef: String? = null,
    val fixId: String? = null,
    val suggestionId: String? = null,
) {
    companion object {
        fun supervisor(question: FleetQuestion?, action: FleetAction?, thread: FleetThread?) = VoiceFocus(
            threadKey = if (question != null) question.threadKey ?: question.threadKeys?.firstOrNull()
                ?: question.chats.firstNotNullOfOrNull { it.threadKey }
                else action?.threadKey ?: thread?.key,
            questionId = question?.id,
            actionId = action?.id,
            prRef = question?.prRef ?: thread?.pr?.ref,
        )
    }
}

object VoiceFrames {
    private val json = Json { explicitNulls = false; encodeDefaults = true }

    fun start(handsFree: Boolean, focus: VoiceFocus): String = buildJsonObject {
        put("type", "start")
        put("gesture", "mic")
        put("mode", if (handsFree) "handsfree" else "ptt")
        put("focus", json.encodeToJsonElement(VoiceFocus.serializer(), focus))
    }.toString()

    fun context(focus: VoiceFocus): String = buildJsonObject {
        put("type", "context")
        put("focus", json.encodeToJsonElement(VoiceFocus.serializer(), focus))
    }.toString()

    fun control(type: String, playedMs: Long? = null): String = buildJsonObject {
        put("type", type)
        if (playedMs != null) put("playedMs", playedMs.coerceAtLeast(0))
    }.toString()

    fun mode(handsFree: Boolean): String = buildJsonObject {
        put("type", "mode")
        put("handsFree", handsFree)
    }.toString()

    fun playback(itemId: String, playedMs: Double): String = buildJsonObject {
        put("type", "playback")
        put("itemId", itemId)
        put("playedMs", playedMs)
    }.toString()

    fun decode(text: String): JsonObject? = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
    fun field(frame: JsonObject, key: String): String? = (frame[key] as? JsonPrimitive)?.content
}

enum class VoicePhase { IDLE, CONNECTING, READY }
enum class VoiceEffect { START_CAPTURE, STOP_CAPTURE, COMMIT, CANCEL, BARGE }

// A release while connecting must never turn the microphone on later.
class VoiceStateMachine {
    var phase = VoicePhase.IDLE
        private set
    var handsFree = false
        private set
    var held = false
        private set
    var recording = false
        private set

    fun start(handsFree: Boolean, held: Boolean) {
        phase = VoicePhase.CONNECTING
        this.handsFree = handsFree
        this.held = held
        recording = false
    }

    fun ready(): List<VoiceEffect> {
        if (phase != VoicePhase.CONNECTING) return emptyList()
        phase = VoicePhase.READY
        return reconcile()
    }

    fun press(): List<VoiceEffect> {
        if (handsFree || held || phase == VoicePhase.IDLE) return emptyList()
        held = true
        return if (phase == VoicePhase.READY) listOf(VoiceEffect.BARGE) + reconcile() else emptyList()
    }

    fun release(commit: Boolean = true): List<VoiceEffect> {
        val wasRecording = recording && !handsFree
        held = false
        return reconcile() + if (wasRecording) listOf(if (commit) VoiceEffect.COMMIT else VoiceEffect.CANCEL) else emptyList()
    }

    fun mode(on: Boolean): List<VoiceEffect> {
        handsFree = on
        held = false
        return reconcile()
    }

    private fun reconcile(): List<VoiceEffect> {
        val want = phase == VoicePhase.READY && (handsFree || held)
        if (want == recording) return emptyList()
        recording = want
        return listOf(if (want) VoiceEffect.START_CAPTURE else VoiceEffect.STOP_CAPTURE)
    }

    fun stop(): List<VoiceEffect> {
        val effects = if (recording) listOf(VoiceEffect.STOP_CAPTURE) else emptyList()
        phase = VoicePhase.IDLE
        handsFree = false
        held = false
        recording = false
        return effects
    }
}

data class VoiceStatus(
    val phase: VoicePhase = VoicePhase.IDLE,
    val handsFree: Boolean = false,
    val recording: Boolean = false,
    val ownerText: String = "",
    val replyText: String = "",
    val message: String? = null,
)

interface VoiceAudioIO {
    fun startCapture(onAudio: (ByteArray) -> Unit, onError: () -> Unit)
    fun stopCapture()
    fun play(pcm: ByteArray, onError: () -> Unit): Boolean
    fun completeReply(audioMs: Double, onPlayed: () -> Unit)
    fun barge(): Long
    fun close()
}

class VoiceSession(
    private val server: String,
    private val token: String,
    private val audio: VoiceAudioIO,
    private val client: OkHttpClient = voiceClient,
    private val enforceAllowlist: Boolean = true,
) {
    private val machine = VoiceStateMachine()
    private val mutableStatus = MutableStateFlow(VoiceStatus())
    val status = mutableStatus.asStateFlow()
    private var socket: WebSocket? = null
    private var focus = VoiceFocus()
    private var replyDone = true
    private var discardAudio = false
    private var closed = false
    private var opened = false
    private var captureGeneration = 0
    private var playbackGeneration = 0
    private var replyPlayed = false
    private var replyRevision = 0

    @Synchronized
    fun press() {
        if (closed) return
        if (machine.phase == VoicePhase.IDLE) connect(false, true) else apply(machine.press())
    }

    @Synchronized
    fun release(commit: Boolean = true) {
        apply(machine.release(commit))
    }

    @Synchronized
    fun handsFree(on: Boolean) {
        if (closed) return
        if (machine.phase == VoicePhase.IDLE) {
            if (on) connect(true, false)
        } else {
            if (opened && !send(VoiceFrames.mode(on))) return
            // End a hands-free turn so partial audio cannot spill into the next hold.
            if (!on && machine.handsFree) stop() else apply(machine.mode(on))
        }
    }

    @Synchronized
    fun setFocus(next: VoiceFocus) {
        if (next == focus) return
        focus = next
        if (opened) send(VoiceFrames.context(next))
    }

    private fun connect(handsFree: Boolean, held: Boolean) {
        machine.start(handsFree, held)
        mutableStatus.value = VoiceStatus(phase = VoicePhase.CONNECTING, handsFree = handsFree, message = "Connecting voice…")
        replyDone = true
        replyPlayed = false
        discardAudio = false
        try {
            require(Regex("^[A-Za-z0-9._~+-]{16,512}$").matches(token))
            val origin = if (enforceAllowlist) HostAllowlist.validate(server) else server.toHttpUrl()
            val url = origin.newBuilder().encodedPath("/nodes/voice").query(null)
                .addQueryParameter("rate", "24000").addQueryParameter("mode", if (handsFree) "handsfree" else "ptt").build()
            val request = Request.Builder().url(url).header("Sec-WebSocket-Protocol", "openagi-voice, $token").build()
            socket = client.newWebSocket(request, listener)
        } catch (_: Exception) {
            finish("Voice could not connect. Check the paired hub and try again.")
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(this@VoiceSession) {
            if (webSocket !== socket) { webSocket.cancel(); return@synchronized }
            opened = true
            send(VoiceFrames.start(machine.handsFree, focus))
        }

        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@VoiceSession) {
            if (webSocket !== socket) return@synchronized
            val frame = VoiceFrames.decode(text) ?: return@synchronized
            fun field(key: String) = VoiceFrames.field(frame, key)
            when (field("type")) {
                "ready" -> { mutableStatus.value = mutableStatus.value.copy(message = null); apply(machine.ready()) }
                "transcript" -> if (field("role") == "owner") mutableStatus.value = mutableStatus.value.copy(ownerText = field("text").orEmpty().take(4000))
                "reply.delta" -> {
                    replyRevision++
                    replyPlayed = false
                    val previous = if (replyDone) "" else mutableStatus.value.replyText
                    replyDone = false
                    mutableStatus.value = mutableStatus.value.copy(replyText = (previous + field("text").orEmpty()).take(4000))
                }
                "reply.done" -> {
                    replyDone = true
                    mutableStatus.value = mutableStatus.value.copy(replyText = field("text").orEmpty().take(4000))
                    val itemId = field("itemId")
                    val audioMs = field("audioMs")?.toDoubleOrNull()
                    if (!discardAudio && !itemId.isNullOrBlank() && itemId != "null" && audioMs != null && audioMs.isFinite() && audioMs > 0) {
                        val generation = playbackGeneration
                        val revision = replyRevision
                        audio.completeReply(audioMs) { synchronized(this@VoiceSession) {
                            if (webSocket === socket && generation == playbackGeneration && !discardAudio) {
                                if (send(VoiceFrames.playback(itemId, audioMs)) && revision == replyRevision) replyPlayed = true
                            }
                        } }
                    }
                }
                "speech_started" -> barge()
                "barged" -> { playbackGeneration++; audio.barge(); discardAudio = false }
                "end" -> finish(field("reason")?.take(200) ?: "Voice ended.")
                "error", "notice" -> mutableStatus.value = mutableStatus.value.copy(message = field("message")?.take(240))
                "confirmation.readback" -> mutableStatus.value = mutableStatus.value.copy(message = field("text")?.take(1000))
                "tool" -> mutableStatus.value = mutableStatus.value.copy(message = field("summary") ?: "${field("name").orEmpty()}: ${field("status").orEmpty()}")
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = synchronized(this@VoiceSession) {
            if (webSocket !== socket || discardAudio) return@synchronized
            replyPlayed = false
            replyRevision++
            val generation = playbackGeneration
            if (bytes.size == 0 || bytes.size % 2 != 0 || !audio.play(bytes.toByteArray()) { synchronized(this@VoiceSession) {
                if (webSocket === socket && generation == playbackGeneration) finish("Reply playback failed. Start voice again.")
            } }) finish("Reply audio fell behind. Start voice again.")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = synchronized(this@VoiceSession) {
            if (webSocket === socket) finish("Voice ended. Start again when ready.")
            webSocket.close(code, null)
            Unit
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(this@VoiceSession) {
            if (webSocket !== socket) return@synchronized
            finish(when (response?.code) {
                404 -> "Voice is off on this hub. Enable OPENAGI_VOICE=1 on the hub and restart it."
                403 -> "Voice access was refused. Re-pair this phone in Settings."
                429 -> "The hub is busy with voice. Try again shortly."
                else -> "Voice disconnected. Check the hub connection and try again."
            })
        }
    }

    private fun send(text: String): Boolean {
        val ws = socket ?: return true // Context and mode are included in start after the handshake.
        if (ws.queueSize() > 256_000 || !ws.send(text)) {
            finish("Voice upload fell behind. Start again.")
            return false
        }
        return true
    }

    private fun barge() {
        // A new push-to-talk hold must not invalidate a fully heard readback.
        if (replyPlayed) return
        playbackGeneration++
        val played = audio.barge()
        discardAudio = true
        send(VoiceFrames.control("barge", played))
    }

    private fun apply(effects: List<VoiceEffect>) {
        for (effect in effects) {
            when (effect) {
                VoiceEffect.START_CAPTURE -> try {
                    val generation = ++captureGeneration
                    audio.startCapture({ pcm -> synchronized(this) {
                        val ws = socket
                        if (generation == captureGeneration && machine.recording && ws != null && (ws.queueSize() > 256_000 || !ws.send(pcm.toByteString()))) finish("Voice upload fell behind. Start again.")
                    } }, { synchronized(this) { if (generation == captureGeneration) finish("Microphone unavailable. Check microphone permission and try again.") } })
                } catch (_: Exception) { finish("Microphone unavailable. Check microphone permission and try again."); return }
                VoiceEffect.STOP_CAPTURE -> { captureGeneration++; audio.stopCapture() }
                VoiceEffect.COMMIT -> if (!send(VoiceFrames.control("commit"))) return
                VoiceEffect.CANCEL -> if (!send(VoiceFrames.control("cancel"))) return
                VoiceEffect.BARGE -> barge()
            }
        }
        mutableStatus.value = mutableStatus.value.copy(phase = machine.phase, handsFree = machine.handsFree, recording = machine.recording)
    }

    @Synchronized
    fun stop() {
        socket?.send(VoiceFrames.control("stop"))
        finish(null, graceful = true)
    }

    private fun finish(message: String?, graceful: Boolean = false) {
        playbackGeneration++
        apply(machine.stop())
        audio.close()
        val ws = socket
        socket = null
        opened = false
        if (graceful) ws?.close(1000, null) else ws?.cancel()
        mutableStatus.value = mutableStatus.value.copy(message = message)
    }

    @Synchronized
    fun close() { stop(); closed = true }

    companion object {
        private val voiceClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
}
