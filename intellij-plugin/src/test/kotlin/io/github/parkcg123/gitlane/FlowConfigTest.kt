package io.github.parkcg123.gitlane

import io.github.parkcg123.gitlane.config.FlowConfig
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class FlowConfigTest {
    @Test
    fun `returns defaults when config file does not exist`(@TempDir tempDir: Path) {
        val loaded = FlowConfig.loadWithWarning(tempDir)
        assertNull(loaded.warning)
        assertEquals(FlowConfig(), loaded.config)
    }

    @Test
    fun `parses valid repository config file`(@TempDir tempDir: Path) {
        Files.writeString(
            tempDir.resolve(FlowConfig.CONFIG_FILENAME),
            """
            {
              "useDevelopBranch": false,
              "developBranch": "stage",
              "masterBranch": "main",
              "remote": "upstream",
              "dateFormat": "YYYYMMDD",
              "separator": "-",
              "returnToDevelopAfterRelease": false,
              "useNoFastForwardMerge": false
            }
            """.trimIndent(),
        )

        val loaded = FlowConfig.loadWithWarning(tempDir)
        assertNull(loaded.warning)
        assertFalse(loaded.config.useDevelopBranch)
        assertEquals("stage", loaded.config.developBranch)
        assertEquals("main", loaded.config.masterBranch)
        assertEquals("upstream", loaded.config.remote)
        assertEquals("-", loaded.config.separator)
        assertFalse(loaded.config.returnToDevelopAfterRelease)
        assertFalse(loaded.config.useNoFastForwardMerge)
    }

    @Test
    fun `falls back to defaults with warning on malformed or non-object json`(@TempDir tempDir: Path) {
        Files.writeString(tempDir.resolve(FlowConfig.CONFIG_FILENAME), "{ broken json")
        val malformed = FlowConfig.loadWithWarning(tempDir)
        assertNotNull(malformed.warning)
        assertEquals(FlowConfig(), malformed.config)

        Files.writeString(tempDir.resolve(FlowConfig.CONFIG_FILENAME), "[1, 2, 3]")
        val nonObject = FlowConfig.loadWithWarning(tempDir)
        assertNotNull(nonObject.warning)
        assertEquals(FlowConfig(), nonObject.config)
    }
}
