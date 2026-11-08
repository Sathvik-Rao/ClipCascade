package com.clipcascade

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Sensitive AsyncStorage rows contain only authenticated ciphertext after migration. */
internal object ProtectedStorage {
    private const val KEY_ALIAS = "ClipCascade.storage.v1"
    private const val PREFIX = "keystore:v1:"
    private const val IV_LENGTH = 12
    private const val TAG_BITS = 128
    private val keys = setOf("password", "hashed_password", "csrf_token")

    @Synchronized
    fun read(storage: AsyncStorageBridge, name: String): String? {
        require(name in keys)
        val stored = storage.getValue(name) ?: return null
        if (stored.isEmpty()) return stored
        if (!stored.startsWith(PREFIX)) {
            // Replace the legacy value in the same SQLite row only after encryption succeeds.
            write(storage, name, stored)
            return stored
        }

        val bytes = Base64.decode(stored.removePrefix(PREFIX), Base64.NO_WRAP)
        require(bytes.size >= IV_LENGTH + TAG_BITS / 8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(TAG_BITS, bytes, 0, IV_LENGTH))
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(bytes, IV_LENGTH, bytes.size - IV_LENGTH).toString(Charsets.UTF_8)
    }

    @Synchronized
    fun write(storage: AsyncStorageBridge, name: String, value: String) {
        require(name in keys)
        val stored = if (value.isEmpty()) value else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            check(cipher.iv.size == IV_LENGTH)
            PREFIX + Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
        }
        check(storage.setValue(name, stored)) { "Could not save protected data" }
    }

    private fun key(create: Boolean): SecretKey {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keystore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        check(create) { "Protected storage key is unavailable" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }
}
