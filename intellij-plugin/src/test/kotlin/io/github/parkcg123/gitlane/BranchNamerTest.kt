package io.github.parkcg123.gitlane

import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.naming.BranchNamer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.LocalDate

class BranchNamerTest {
    @Test
    fun `formats local calendar date as YYYYMMDD`() {
        val date = LocalDate.of(2026, 11, 19)
        assertEquals("20261119", BranchNamer.formatLocalDate(date))
    }

    @Test
    fun `sanitizes whitespace, duplicate separators, and leading or trailing separators`() {
        assertEquals("login_fix", BranchNamer.sanitizeTaskName("  login   fix  "))
        assertEquals("결제_오류_수정", BranchNamer.sanitizeTaskName("__결제___오류 수정__"))
        assertEquals("auth-hotfix", BranchNamer.sanitizeTaskName("--auth   hotfix--", "-"))
    }

    @Test
    fun `validates forbidden git ref characters and edge cases`() {
        assertNotNull(BranchNamer.validateTaskName("   "))
        assertNotNull(BranchNamer.validateTaskName("___"))
        assertNotNull(BranchNamer.validateTaskName("feat/login"))
        assertNotNull(BranchNamer.validateTaskName("a..b"))
        assertNotNull(BranchNamer.validateTaskName("a@{b}"))
        assertNotNull(BranchNamer.validateTaskName("bad~name"))
        assertNotNull(BranchNamer.validateTaskName(".hidden"))
        assertNotNull(BranchNamer.validateTaskName("trailing."))
        assertNotNull(BranchNamer.validateTaskName("branch.lock"))
        assertNull(BranchNamer.validateTaskName("로그인_오류_수정"))
    }

    @Test
    fun `builds branch name and checks protected branches`() {
        val cfg = FlowConfig(developBranch = "stage", masterBranch = "main", separator = "-")
        val date = LocalDate.of(2026, 11, 19)
        assertEquals("20261119-hotfix-cart", BranchNamer.buildTaskBranchName("  hotfix  cart ", cfg, date))
        assertTrue(BranchNamer.isProtectedBranch("stage", cfg))
        assertTrue(BranchNamer.isProtectedBranch("main", cfg))
        assertFalse(BranchNamer.isProtectedBranch("20261119-hotfix-cart", cfg))

        val directCfg = FlowConfig(
            useDevelopBranch = false,
            developBranch = "stage",
            masterBranch = "main",
            separator = "-",
        )
        assertFalse(BranchNamer.isProtectedBranch("stage", directCfg))
        assertTrue(BranchNamer.isProtectedBranch("main", directCfg))
    }
}
