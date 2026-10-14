package sh.openagi.mobile.voice

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class VoiceAudioTest {
    private class Focus : VoiceFocusControl {
        var acquired = false
        override fun acquire(onLoss: () -> Unit): Boolean { acquired = true; return true }
        override fun release() { acquired = false }
    }

    @Test fun sessionOwnsFocusThroughBargeAndReleasesOnClose() {
        val focus = Focus()
        val audio = VoiceAudio(focus) { StalledOutput() }
        try {
            assertTrue(audio.open {})
            assertTrue(focus.acquired)
            audio.barge()
            assertTrue(focus.acquired)
        } finally { audio.close() }
        assertFalse(focus.acquired)
    }

    private class StalledOutput : VoiceOutput {
        @Volatile var draining = false
        private var bytes = 0
        override val head get() = bytes / 2L
        override fun start() {}
        override fun write(pcm: ByteArray, offset: Int, count: Int): Int {
            if (!draining) return 0
            bytes += count
            return count
        }
        override fun close() {}
    }

    @Test fun burstReplyWithSmallDeltasPlaysToCompletion() {
        val output = StalledOutput()
        val audio = VoiceAudio(Focus()) { output }
        val completed = CountDownLatch(1)
        try {
            // Twelve seconds delivered before the speaker can drain any of it.
            repeat(VoiceAudio.RATE * 2 * 12 / 240) {
                assertTrue(audio.play(ByteArray(240)) { fail("Reply playback failed") })
            }
            audio.completeReply(12_000.0) { completed.countDown() }
            assertEquals(1L, completed.count)
            output.draining = true
            assertTrue(completed.await(3, TimeUnit.SECONDS))
        } finally { audio.close() }
    }

    @Test fun byteCapRejectsWholeDeltaAndBargeClearsCapacity() {
        val audio = VoiceAudio(Focus()) { StalledOutput() }
        try {
            assertTrue(audio.play(ByteArray(VoiceAudio.MAX_QUEUED_BYTES)) {})
            assertFalse(audio.play(byteArrayOf(0, 1)) {})
            audio.barge()
            assertTrue(audio.play(ByteArray(VoiceAudio.MAX_QUEUED_BYTES)) {})
        } finally { audio.close() }
    }

    private class Output(private val failure: Boolean, private val throws: Boolean = false) : VoiceOutput {
        @Volatile var closed = false
        val wrote = CountDownLatch(1)
        override val head = 0L
        override fun start() {}
        override fun write(pcm: ByteArray, offset: Int, count: Int): Int {
            wrote.countDown()
            if (throws) error("Track unavailable")
            return if (failure) -6 else count
        }
        override fun close() { closed = true }
    }

    @Test fun failedWorkerReleasesTrackReportsErrorAndAllowsNewPlayer() {
        for (throws in listOf(false, true)) {
            val failed = Output(true, throws)
            val replacement = Output(false)
            var attempts = 0
            val audio = VoiceAudio(Focus()) { if (attempts++ == 0) failed else replacement }
            val error = CountDownLatch(1)
            try {
                assertTrue(audio.play(byteArrayOf(0, 1)) { error.countDown() })
                assertTrue(error.await(3, TimeUnit.SECONDS))
                assertTrue(failed.closed)
                assertTrue(audio.play(byteArrayOf(0, 2)) { fail("Replacement playback failed") })
                assertTrue(replacement.wrote.await(3, TimeUnit.SECONDS))
                assertEquals(2, attempts)
            } finally { audio.close() }
            assertTrue(replacement.closed)
        }
    }
}
