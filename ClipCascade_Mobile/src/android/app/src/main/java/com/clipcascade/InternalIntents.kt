package com.clipcascade

import android.content.Context
import android.content.Intent
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Authenticates intents that are only meant to come from ClipCascade itself.
 *
 * MainActivity has to stay exported: it is the LAUNCHER activity and the
 * share/PROCESS_TEXT target. An exported activity accepts any *explicit*
 * intent regardless of its intent-filters, so without a check here any
 * installed app could start it with one of our internal actions and drive
 * privileged behaviour — notably making ClipCascade read the clipboard and put
 * it on the wire at a moment of the caller's choosing. Android 10+ blocks
 * background clipboard reads precisely to prevent that, and the tile exists
 * because of the same restriction, so this must not become a way around it.
 *
 * The token lives in the app's private storage: other apps cannot read it, and
 * it survives process death so notification and tile PendingIntents stay valid
 * across restarts.
 */
object InternalIntents {
    const val EXTRA_TOKEN = "com.clipcascade.extra.INTERNAL_TOKEN"

    private const val PREFS = "cc_internal_intents"
    private const val KEY = "token"

    @Synchronized
    fun token(context: Context): String {
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }

        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val token = bytes.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        prefs.edit().putString(KEY, token).apply()
        return token
    }

    /** Stamp an intent we are about to hand to the framework on our own behalf. */
    fun stamp(context: Context, intent: Intent): Intent =
        intent.putExtra(EXTRA_TOKEN, token(context))

    fun isInternal(context: Context, intent: Intent): Boolean {
        val provided = intent.getStringExtra(EXTRA_TOKEN) ?: return false
        return MessageDigest.isEqual(
            provided.toByteArray(Charsets.UTF_8),
            token(context).toByteArray(Charsets.UTF_8),
        )
    }
}
