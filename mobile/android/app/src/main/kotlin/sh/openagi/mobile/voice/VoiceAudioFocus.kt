package sh.openagi.mobile.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

internal interface VoiceFocusControl {
    fun acquire(onLoss: () -> Unit): Boolean
    fun release()
}

internal class VoiceAudioFocus(context: Context) : VoiceFocusControl {
    private val manager = context.applicationContext.getSystemService(AudioManager::class.java)
    @Volatile private var request: AudioFocusRequest? = null

    override fun acquire(onLoss: () -> Unit): Boolean {
        release()
        lateinit var current: AudioFocusRequest
        current = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener({ change ->
                if (change < 0 && request === current) onLoss()
            }, Handler(Looper.getMainLooper())).build()
        request = current
        if (manager.requestAudioFocus(current) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return true
        release()
        return false
    }

    override fun release() {
        val current = request ?: return
        request = null
        manager.abandonAudioFocusRequest(current)
    }
}
