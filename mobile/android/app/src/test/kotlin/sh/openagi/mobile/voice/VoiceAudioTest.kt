package sh.openagi.mobile.voice

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class VoiceAudioTest {
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
            val audio = VoiceAudio { if (attempts++ == 0) failed else replacement }
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
