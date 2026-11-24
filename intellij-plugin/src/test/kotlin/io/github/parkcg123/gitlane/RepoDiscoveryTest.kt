package io.github.parkcg123.gitlane

import io.github.parkcg123.gitlane.git.RepoDiscovery
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class RepoDiscoveryTest {
    private fun initGitDir(dir: Path) {
        Files.createDirectories(dir)
        val process = ProcessBuilder("git", "init")
            .directory(dir.toFile())
            .apply { environment()["GIT_TERMINAL_PROMPT"] = "0" }
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        require(exitCode == 0) { "git init failed: $output" }
    }

    @Test
    fun `scanNestedGitRepos discovers sibling repos and git pointer files while ignoring deps and build`(@TempDir root: Path) {
        val realRoot = RepoDiscovery.normalizePath(root)
        val frontend = realRoot.resolve("frontend")
        val backend = realRoot.resolve("backend")
        val worker = realRoot.resolve("services/worker")
        val ignoredNodeModules = realRoot.resolve("node_modules/pkg")
        val ignoredBuild = realRoot.resolve("build/temp_repo")

        initGitDir(frontend)
        initGitDir(backend)
        Files.createDirectories(worker)
        Files.writeString(worker.resolve(".git"), "gitdir: ../.git/worktrees/worker\n")
        initGitDir(ignoredNodeModules)
        initGitDir(ignoredBuild)

        val discovered = RepoDiscovery.scanNestedGitRepos(realRoot, 2)
        assertEquals(
            setOf(frontend, backend, worker),
            discovered.toSet(),
        )

        val emptyDir = realRoot.resolve("empty")
        Files.createDirectories(emptyDir)
        assertTrue(RepoDiscovery.scanNestedGitRepos(emptyDir, 2).isEmpty())
    }

    @Test
    fun `buildRepoLabels deduplicates, disambiguates duplicate names, and findContainingRepo matches deepest root`(@TempDir root: Path) {
        val realRoot = RepoDiscovery.normalizePath(root)
        val appWeb = realRoot.resolve("apps/web")
        val pkgWeb = realRoot.resolve("packages/web")
        val mono = realRoot.resolve("mono")
        val core = mono.resolve("libs/core")

        initGitDir(appWeb)
        initGitDir(pkgWeb)
        initGitDir(mono)
        initGitDir(core)

        val labeled = RepoDiscovery.buildRepoLabels(
            roots = listOf(appWeb, pkgWeb, appWeb, mono, core),
            workspaceRoots = listOf(realRoot),
        )
        val byRoot = labeled.associateBy { it.root }

        assertEquals(4, labeled.size)
        assertEquals("apps/web", byRoot[appWeb]?.label)
        assertEquals("packages/web", byRoot[pkgWeb]?.label)
        assertEquals("mono", byRoot[mono]?.label)
        assertEquals("core", byRoot[core]?.label)

        val subFile = core.resolve("src/Main.kt")
        Files.createDirectories(subFile.parent)
        Files.writeString(subFile, "// sub\n")

        val monoFile = mono.resolve("README.md")
        Files.writeString(monoFile, "# mono\n")

        assertEquals(core, RepoDiscovery.findContainingRepo(subFile, labeled)?.root)
        assertEquals(mono, RepoDiscovery.findContainingRepo(monoFile, labeled)?.root)
        assertNull(RepoDiscovery.findContainingRepo(realRoot.resolve("outside.txt"), labeled))

        assertEquals(core, RepoDiscovery.findGitRootForPath(subFile))
        assertNull(RepoDiscovery.findGitRootForPath(realRoot.resolve("outside.txt")))
    }
}
