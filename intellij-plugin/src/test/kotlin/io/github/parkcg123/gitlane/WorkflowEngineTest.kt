package io.github.parkcg123.gitlane

import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.workflow.ConflictPromptChoice
import io.github.parkcg123.gitlane.workflow.MergeToDevelopChoice
import io.github.parkcg123.gitlane.workflow.PendingConflictContext
import io.github.parkcg123.gitlane.workflow.WorkflowEngine
import io.github.parkcg123.gitlane.workflow.WorkflowStatus
import io.github.parkcg123.gitlane.workflow.WorkflowUi
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDate

class WorkflowEngineTest {
    private class ScriptedUi(
        var taskName: String? = "login_fix",
        var dirtyStart: Boolean = false,
        var existingBranch: Boolean = false,
        var mergeChoice: MergeToDevelopChoice = MergeToDevelopChoice.DELETE,
        var releaseConfirm: Boolean = true,
        var abortConfirm: Boolean = true,
        var conflictAction: ConflictPromptChoice = ConflictPromptChoice.LATER,
    ) : WorkflowUi {
        private var pending: PendingConflictContext? = null
        val infoMessages = mutableListOf<String>()
        val warningMessages = mutableListOf<String>()
        val errorMessages = mutableListOf<String>()
        val openedConflictFiles = mutableListOf<List<String>>()

        override fun promptTaskName(datePrefix: String): String? = taskName
        override fun confirmDirtyStart(): Boolean = dirtyStart
        override fun confirmExistingBranch(branchName: String): Boolean = existingBranch
        override fun confirmMergeToDevelop(
            taskBranch: String,
            developBranch: String,
            commitCount: Int,
        ): MergeToDevelopChoice = mergeChoice

        override fun confirmReleaseToMaster(
            developBranch: String,
            masterBranch: String,
            aheadCommits: List<String>,
        ): Boolean = releaseConfirm

        override fun confirmAbortMerge(targetBranch: String): Boolean = abortConfirm

        override fun promptConflictAction(
            context: PendingConflictContext,
            conflictedFiles: List<String>,
        ): ConflictPromptChoice = conflictAction

        override fun showInfo(message: String) {
            infoMessages.add(message)
        }

        override fun showWarning(message: String) {
            warningMessages.add(message)
        }

        override fun showError(message: String) {
            errorMessages.add(message)
        }

        override fun openConflictedFiles(files: List<String>) {
            openedConflictFiles.add(files)
        }

        override fun getPendingConflict(): PendingConflictContext? = pending

        override fun setPendingConflict(context: PendingConflictContext?) {
            pending = context
        }
    }

    private data class RepoFixture(
        val origin: Path,
        val work: Path,
        val peer: Path,
    )

    private fun runGit(cwd: Path, vararg args: String): String {
        val process = ProcessBuilder("git", *args)
            .directory(cwd.toFile())
            .apply { environment()["GIT_TERMINAL_PROMPT"] = "0" }
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val exitCode = process.waitFor()
        require(exitCode == 0) { "git ${args.joinToString(" ")} failed ($exitCode): $output" }
        return output.trim()
    }

    private fun createFixture(root: Path): RepoFixture {
        val origin = root.resolve("origin.git")
        val seed = root.resolve("seed")
        val work = root.resolve("work")
        val peer = root.resolve("peer")

        Files.createDirectories(origin)
        runGit(origin, "init", "--bare")

        runGit(root, "clone", origin.toString(), seed.toString())
        runGit(seed, "config", "user.email", "test@example.com")
        runGit(seed, "config", "user.name", "Test User")
        Files.writeString(seed.resolve("app.txt"), "initial\n")
        runGit(seed, "add", "app.txt")
        runGit(seed, "commit", "-m", "initial commit")
        runGit(seed, "checkout", "-B", "master")
        runGit(seed, "push", "-u", "origin", "master")
        runGit(seed, "checkout", "-b", "develop")
        runGit(seed, "push", "-u", "origin", "develop")

        runGit(root, "clone", "-b", "develop", origin.toString(), work.toString())
        runGit(work, "config", "user.email", "dev@example.com")
        runGit(work, "config", "user.name", "Dev User")

        runGit(root, "clone", "-b", "develop", origin.toString(), peer.toString())
        runGit(peer, "config", "user.email", "peer@example.com")
        runGit(peer, "config", "user.name", "Peer User")

        return RepoFixture(origin, work, peer)
    }

    private val fixedDate: LocalDate = LocalDate.of(2026, 11, 19)

    @Test
    fun `startTask syncs develop, creates branch, and handles dirty stash`(@TempDir root: Path) {
        val fixture = createFixture(root)
        Files.writeString(fixture.peer.resolve("peer.txt"), "from peer\n")
        runGit(fixture.peer, "add", "peer.txt")
        runGit(fixture.peer, "commit", "-m", "peer update")
        runGit(fixture.peer, "push", "origin", "develop")

        Files.writeString(fixture.work.resolve("app.txt"), "dirty local edit\n")

        val git = GitRunner(fixture.work)
        val ui = ScriptedUi(taskName = "  oauth   login ", dirtyStart = true)
        val engine = WorkflowEngine(git, ui, FlowConfig()) { fixedDate }

        val result = engine.startTask()
        assertEquals(WorkflowStatus.SUCCESS, result.status)
        assertEquals("20261119_oauth_login", result.branch)
        assertEquals("20261119_oauth_login", git.getCurrentBranch())
        assertTrue(Files.exists(fixture.work.resolve("peer.txt")))
        assertEquals("initial\n", Files.readString(fixture.work.resolve("app.txt")))
        assertTrue(runGit(fixture.work, "stash", "list").contains("auto-stash before startTask"))
    }

    @Test
    fun `mergeToDevelop supports delete and keep modes and blocks protected or dirty states`(@TempDir root: Path) {
        val fixture = createFixture(root)
        val git = GitRunner(fixture.work)
        val ui = ScriptedUi(taskName = "feature_a", mergeChoice = MergeToDevelopChoice.DELETE)
        val engine = WorkflowEngine(git, ui, FlowConfig()) { fixedDate }

        // Protected branch guardrail
        val blockedProtected = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.BLOCKED, blockedProtected.status)

        // Create task branch and commit
        engine.startTask()
        Files.writeString(fixture.work.resolve("feature.txt"), "feature a\n")
        runGit(fixture.work, "add", "feature.txt")
        runGit(fixture.work, "commit", "-m", "feat: add feature a")

        // Dirty tree guardrail
        Files.writeString(fixture.work.resolve("uncommitted.txt"), "wip\n")
        val blockedDirty = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.BLOCKED, blockedDirty.status)
        Files.delete(fixture.work.resolve("uncommitted.txt"))

        // Delete mode
        val mergedDelete = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.SUCCESS, mergedDelete.status)
        assertEquals("develop", git.getCurrentBranch())
        assertFalse(git.branchExistsLocal("20261119_feature_a"))
        assertTrue(runGit(fixture.work, "log", "-1", "--pretty=%P", "origin/develop").contains(" "))

        // Keep mode
        ui.taskName = "feature_b"
        ui.mergeChoice = MergeToDevelopChoice.KEEP
        engine.startTask()
        Files.writeString(fixture.work.resolve("feature_b.txt"), "feature b\n")
        runGit(fixture.work, "add", "feature_b.txt")
        runGit(fixture.work, "commit", "-m", "feat: add feature b")

        val mergedKeep = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.SUCCESS, mergedKeep.status)
        assertEquals("20261119_feature_b", git.getCurrentBranch())
        assertTrue(git.branchExistsLocal("20261119_feature_b"))
    }

    @Test
    fun `releaseToMaster merges develop into master, pushes, and returns to develop`(@TempDir root: Path) {
        val fixture = createFixture(root)
        val git = GitRunner(fixture.work)
        val ui = ScriptedUi(taskName = "release_item")
        val engine = WorkflowEngine(git, ui, FlowConfig(returnToDevelopAfterRelease = true)) { fixedDate }

        engine.startTask()
        Files.writeString(fixture.work.resolve("release.txt"), "release content\n")
        runGit(fixture.work, "add", "release.txt")
        runGit(fixture.work, "commit", "-m", "feat: ready for release")
        engine.mergeToDevelop()

        val releaseResult = engine.releaseToMaster()
        assertEquals(WorkflowStatus.SUCCESS, releaseResult.status)
        assertEquals("develop", git.getCurrentBranch())
        assertEquals(
            runGit(fixture.work, "rev-parse", "master"),
            runGit(fixture.work, "rev-parse", "origin/master"),
        )
        assertTrue(git.getAheadCommits("master", "develop").isEmpty())
    }

    @Test
    fun `conflict flow supports abort and resolve-then-continue`(@TempDir root: Path) {
        val fixture = createFixture(root)
        val git = GitRunner(fixture.work)
        val ui = ScriptedUi(taskName = "conflict_fix", mergeChoice = MergeToDevelopChoice.DELETE)
        val engine = WorkflowEngine(git, ui, FlowConfig()) { fixedDate }

        engine.startTask()
        Files.writeString(fixture.work.resolve("app.txt"), "from task\n")
        runGit(fixture.work, "add", "app.txt")
        runGit(fixture.work, "commit", "-m", "task change")

        // Peer pushes conflicting change on develop
        Files.writeString(fixture.peer.resolve("app.txt"), "from peer\n")
        runGit(fixture.peer, "add", "app.txt")
        runGit(fixture.peer, "commit", "-m", "peer change")
        runGit(fixture.peer, "push", "origin", "develop")

        // Case 1: Abort immediately from conflict prompt
        ui.conflictAction = ConflictPromptChoice.ABORT
        val aborted = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.SUCCESS, aborted.status)
        assertFalse(git.isMergeInProgress())
        assertEquals("20261119_conflict_fix", git.getCurrentBranch())
        assertNull(ui.getPendingConflict())

        // Case 2: Pause on conflict, resolve file, then continueAfterConflict
        ui.conflictAction = ConflictPromptChoice.LATER
        val conflicted = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.CONFLICT, conflicted.status)
        assertTrue(git.isMergeInProgress())
        assertEquals(listOf("app.txt"), git.getConflictedFiles())
        assertEquals("develop", ui.getPendingConflict()?.targetBranch)

        // Blocked while unresolved
        val stillConflicted = engine.continueAfterConflict()
        assertEquals(WorkflowStatus.CONFLICT, stillConflicted.status)
        assertEquals(1, ui.openedConflictFiles.size)

        // Resolve conflict and stage
        Files.writeString(fixture.work.resolve("app.txt"), "resolved content\n")
        runGit(fixture.work, "add", "app.txt")

        val completed = engine.continueAfterConflict()
        assertEquals(WorkflowStatus.SUCCESS, completed.status)
        assertFalse(git.isMergeInProgress())
        assertEquals("develop", git.getCurrentBranch())
        assertFalse(git.branchExistsLocal("20261119_conflict_fix"))
        assertNull(ui.getPendingConflict())
        assertEquals(
            runGit(fixture.work, "rev-parse", "develop"),
            runGit(fixture.work, "rev-parse", "origin/develop"),
        )
    }

    @Test
    fun `direct-to-master mode forks from master, merges directly, and resolves conflicts without develop`(@TempDir root: Path) {
        val origin = root.resolve("origin.git")
        val seed = root.resolve("seed")
        val work = root.resolve("work")
        val peer = root.resolve("peer")

        Files.createDirectories(origin)
        runGit(origin, "init", "--bare")

        runGit(root, "clone", origin.toString(), seed.toString())
        runGit(seed, "config", "user.email", "test@example.com")
        runGit(seed, "config", "user.name", "Test User")
        Files.writeString(seed.resolve("app.txt"), "initial\n")
        runGit(seed, "add", "app.txt")
        runGit(seed, "commit", "-m", "initial commit")
        runGit(seed, "checkout", "-B", "master")
        runGit(seed, "push", "-u", "origin", "master")

        runGit(root, "clone", "-b", "master", origin.toString(), work.toString())
        runGit(work, "config", "user.email", "dev@example.com")
        runGit(work, "config", "user.name", "Dev User")

        runGit(root, "clone", "-b", "master", origin.toString(), peer.toString())
        runGit(peer, "config", "user.email", "peer@example.com")
        runGit(peer, "config", "user.name", "Peer User")

        val git = GitRunner(work)
        val ui = ScriptedUi(taskName = "direct_fix", mergeChoice = MergeToDevelopChoice.DELETE)
        val engine = WorkflowEngine(git, ui, FlowConfig(useDevelopBranch = false)) { fixedDate }

        // releaseToMaster is blocked when develop is disabled
        val blockedRelease = engine.releaseToMaster()
        assertEquals(WorkflowStatus.BLOCKED, blockedRelease.status)

        // Start task directly from master
        val started = engine.startTask()
        assertEquals(WorkflowStatus.SUCCESS, started.status)
        assertEquals("20261119_direct_fix", git.getCurrentBranch())

        // Clean direct merge into master
        Files.writeString(work.resolve("direct.txt"), "direct feature\n")
        runGit(work, "add", "direct.txt")
        runGit(work, "commit", "-m", "feat: direct change")

        val merged = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.SUCCESS, merged.status)
        assertEquals("master", merged.branch)
        assertEquals("master", git.getCurrentBranch())
        assertFalse(git.branchExistsLocal("20261119_direct_fix"))
        assertEquals(
            runGit(work, "rev-parse", "master"),
            runGit(work, "rev-parse", "origin/master"),
        )

        // Direct-to-master conflict + resolve + continue
        ui.taskName = "direct_conflict"
        ui.conflictAction = ConflictPromptChoice.LATER
        engine.startTask()
        Files.writeString(work.resolve("app.txt"), "task direct edit\n")
        runGit(work, "add", "app.txt")
        runGit(work, "commit", "-m", "fix: task direct edit")

        runGit(peer, "pull", "--ff-only", "origin", "master")
        Files.writeString(peer.resolve("app.txt"), "peer master edit\n")
        runGit(peer, "add", "app.txt")
        runGit(peer, "commit", "-m", "fix: peer master edit")
        runGit(peer, "push", "origin", "master")

        val conflicted = engine.mergeToDevelop()
        assertEquals(WorkflowStatus.CONFLICT, conflicted.status)
        assertEquals(PendingConflictContext.KIND_MERGE_TO_MASTER, ui.getPendingConflict()?.kind)
        assertEquals("master", ui.getPendingConflict()?.targetBranch)

        Files.writeString(work.resolve("app.txt"), "resolved direct edit\n")
        runGit(work, "add", "app.txt")

        val completed = engine.continueAfterConflict()
        assertEquals(WorkflowStatus.SUCCESS, completed.status)
        assertEquals("master", git.getCurrentBranch())
        assertFalse(git.branchExistsLocal("20261119_direct_conflict"))
        assertNull(ui.getPendingConflict())
        assertEquals(
            runGit(work, "rev-parse", "master"),
            runGit(work, "rev-parse", "origin/master"),
        )
    }
}
