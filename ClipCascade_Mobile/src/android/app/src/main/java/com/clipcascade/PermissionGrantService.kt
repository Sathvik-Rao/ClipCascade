package com.clipcascade

import java.util.concurrent.TimeUnit

/** Short-lived Shizuku service for ClipCascade's permission setup and force-stop. */
class PermissionGrantService : IPermissionGrantService.Stub() {
    override fun grantPermissions(userId: Int): String {
        require(userId >= 0)
        val commands = listOf(
            listOf("appops", "set", "--user", userId.toString(), BuildConfig.APPLICATION_ID,
                "SYSTEM_ALERT_WINDOW", "allow"),
            // READ_LOGS changes supplementary groups, so Android can kill the app
            // immediately. Do this last, after overlay access has been configured.
            listOf("pm", "grant", "--user", userId.toString(), BuildConfig.APPLICATION_ID,
                "android.permission.READ_LOGS")
        )
        // Attempt both commands so a partial grant can be reported and retried.
        return commands.mapNotNull { runCommand(it) }.joinToString("\n")
    }

    override fun forceStopApp(userId: Int): String {
        require(userId >= 0)
        return runCommand(listOf("am", "force-stop", "--user", userId.toString(),
            BuildConfig.APPLICATION_ID)).orEmpty()
    }

    private fun runCommand(command: List<String>): String? {
        return try {
            val process = ProcessBuilder(command).redirectErrorStream(true).start()
            try {
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    "${command.first()} timed out"
                } else {
                    val output = process.inputStream.bufferedReader().use { it.readText() }.trim()
                    if (process.exitValue() == 0) null
                    else "${command.first()} failed: ${output.take(1000)}"
                }
            } finally {
                process.destroy()
            }
        } catch (e: Exception) {
            "${command.first()} failed: ${e.message}"
        }
    }

    override fun destroy() { System.exit(0) }
}
