package sh.openagi.mobile.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class VoiceAudio : VoiceAudioIO {
    private class Capture(val record: AudioRecord) { @Volatile var active = true }
    private var capture: Capture? = null
    private var track: AudioTrack? = null
    private var player: Thread? = null
    private var queue = ArrayBlockingQueue<ByteArray>(250)
    private var playback = VoicePlayback(RATE)

    @SuppressLint("MissingPermission")
    @Synchronized
    override fun startCapture(onAudio: (ByteArray) -> Unit, onError: () -> Unit) {
        if (capture != null) return
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0)
        val record = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(format(AudioFormat.CHANNEL_IN_MONO)).setBufferSizeInBytes(maxOf(minimum, FRAME_BYTES * 4)).build()
        if (record.state != AudioRecord.STATE_INITIALIZED) { record.release(); error("Microphone unavailable") }
        val current = Capture(record)
        capture = current
        thread(name = "voice-capture") {
            var echo: AcousticEchoCanceler? = null
            var noise: NoiseSuppressor? = null
            try {
                if (AcousticEchoCanceler.isAvailable()) echo = runCatching { AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true } }.getOrNull()
                if (NoiseSuppressor.isAvailable()) noise = runCatching { NoiseSuppressor.create(record.audioSessionId)?.also { it.enabled = true } }.getOrNull()
                if (current.active) record.startRecording()
                val buffer = ByteArray(FRAME_BYTES)
                while (current.active) {
                    val count = record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (!current.active) break
                    if (count <= 0 || count % 2 != 0) error("Microphone read failed")
                    onAudio(buffer.copyOf(count))
                }
            } catch (_: Exception) {
                if (current.active) onError()
            } finally {
                echo?.release()
                noise?.release()
                runCatching { record.stop() }
                record.release()
            }
        }
    }

    @Synchronized
    override fun stopCapture() {
        val current = capture ?: return
        capture = null
        current.active = false
        runCatching { current.record.stop() }
    }

    @Synchronized
    override fun play(pcm: ByteArray): Boolean {
        if (track == null) {
            val minimum = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minimum <= 0) return false
            val created = runCatching {
                AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(format(AudioFormat.CHANNEL_OUT_MONO)).setBufferSizeInBytes(maxOf(minimum, FRAME_BYTES * 4))
                    .setTransferMode(AudioTrack.MODE_STREAM).build()
            }.getOrNull() ?: return false
            if (created.state != AudioTrack.STATE_INITIALIZED) { created.release(); return false }
            track = created
            created.play()
            val pending = queue
            player = thread(name = "voice-playback") {
                try {
                    while (!Thread.currentThread().isInterrupted) {
                        val callbacks = synchronized(this) {
                            if (track !== created || pending !== queue) return@thread
                            playback.played(created.playbackHeadPosition.toLong() and 0xffffffffL)
                        }
                        callbacks.forEach { it() }
                        val chunk = pending.poll(10, TimeUnit.MILLISECONDS) ?: continue
                        var offset = 0
                        while (offset < chunk.size) {
                            val count = synchronized(this) {
                                if (track !== created || pending !== queue) return@thread
                                created.write(chunk, offset, minOf(FRAME_BYTES, chunk.size - offset), AudioTrack.WRITE_NON_BLOCKING)
                            }
                            if (count < 0) return@thread
                            offset += count
                            if (count == 0) Thread.sleep(5)
                        }
                    }
                } catch (_: InterruptedException) { /* stopped */ }
            }
        }
        // Five seconds of reply audio is plenty; fail instead of growing memory.
        var offset = 0
        while (offset < pcm.size) {
            val end = minOf(offset + FRAME_BYTES, pcm.size)
            if (!queue.offer(pcm.copyOfRange(offset, end))) return false
            offset = end
        }
        playback.append(pcm.size)
        return true
    }

    @Synchronized
    override fun completeReply(audioMs: Double, onPlayed: () -> Unit) { playback.complete(audioMs, onPlayed) }

    @Synchronized
    override fun barge(): Long {
        val current = track
        val head = current?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0
        val played = playback.playedMs(head)
        stopPlayback()
        return played
    }

    private fun stopPlayback() {
        player?.interrupt()
        player = null
        queue.clear()
        queue = ArrayBlockingQueue(250)
        track?.let { runCatching { it.pause(); it.flush() }; it.release() }
        track = null
        playback = VoicePlayback(RATE)
    }

    @Synchronized
    override fun close() { stopCapture(); stopPlayback() }

    companion object {
        const val RATE = 24000
        private const val FRAME_BYTES = 960 // 20 ms of PCM16 mono.
        private fun format(channels: Int) = AudioFormat.Builder().setSampleRate(RATE)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(channels).build()
    }
}
