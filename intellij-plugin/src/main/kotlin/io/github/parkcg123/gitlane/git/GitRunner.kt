package io.github.parkcg123.gitlane.git

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

class GitRunnerException(
    message: String,
    val args: List<String>,
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
) : RuntimeException(message)

data class GitExecResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
)

data class MergeOutcome(
    val ok: Boolean,
    val conflicted: Boolean,
    val conflictedFiles: List<String>,
    val output: String,
)

class GitRunner(private val repoRoot: Path) {
    private fun runRaw(vararg args: String): GitExecResult {
        val command = listOf("git", *args)
        val process = try {
            ProcessBuilder(command)
                .directory(repoRoot.toFile())
                .apply {
                    environment()["GIT_TERMINAL_PROMPT"] = "0"
                }
                .start()
        } catch (e: IOException) {
            throw GitRunnerException(
                "git 명령 실행에 실패했습니다: ${e.message}",
                args.toList(),
                -1,
                "",
                e.message.orEmpty(),
            )
        }

        // Drain stdout and stderr concurrently so large outputs cannot deadlock the pipe buffer.
        val stderrFuture = CompletableFuture.supplyAsync {
            process.errorStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        }
        val stdout = process.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val stderr = stderrFuture.join()
        val exitCode = process.waitFor()
        return GitExecResult(exitCode, stdout, stderr)
    }

    private fun runOrThrow(vararg args: String): GitExecResult {
        val res = runRaw(*args)
        if (res.exitCode != 0) {
            val detail = (res.stderr.ifBlank { res.stdout }).trim().ifBlank { "exit code ${res.exitCode}" }
            throw GitRunnerException(
                "git ${args.joinToString(" ")} 실패: $detail",
                args.toList(),
                res.exitCode,
                res.stdout,
                res.stderr,
            )
        }
        return res
    }

    fun getRepoRoot(): Path {
        return Path.of(runOrThrow("rev-parse", "--show-toplevel").stdout.trim())
    }

    fun getCurrentBranch(): String? {
        val res = runRaw("symbolic-ref", "--quiet", "--short", "HEAD")
        if (res.exitCode == 0) {
            return res.stdout.trim().takeIf { it.isNotEmpty() }
        }
        return null
    }

    fun listLocalBranches(): List<String> {
        return runOrThrow("for-each-ref", "--format=%(refname:short)", "refs/heads/")
            .stdout
            .lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    fun isMergeInProgress(): Boolean {
        return runRaw("rev-parse", "--verify", "-q", "MERGE_HEAD").exitCode == 0
    }

    fun isRebaseInProgress(): Boolean {
        val gitDir = Path.of(runOrThrow("rev-parse", "--git-dir").stdout.trim())
        val resolved = if (gitDir.isAbsolute) gitDir else repoRoot.resolve(gitDir)
        return Files.exists(resolved.resolve("rebase-merge")) || Files.exists(resolved.resolve("rebase-apply"))
    }

    fun getConflictedFiles(): List<String> {
        return runOrThrow("diff", "-z", "--name-only", "--diff-filter=U")
            .stdout
            .split('\u0000')
            .filter { it.isNotEmpty() }
    }

    fun hasUncommittedChanges(): Boolean {
        return runOrThrow("status", "--porcelain").stdout.trim().isNotEmpty()
    }

    fun hasRemote(remote: String): Boolean {
        return runRaw("remote", "get-url", remote).exitCode == 0
    }

    fun branchExistsLocal(branch: String): Boolean {
        return runRaw("show-ref", "--verify", "--quiet", "refs/heads/$branch").exitCode == 0
    }

    fun branchExistsRemote(remote: String, branch: String): Boolean {
        return runRaw("show-ref", "--verify", "--quiet", "refs/remotes/$remote/$branch").exitCode == 0
    }

    fun fetch(remote: String) {
        runOrThrow("fetch", remote, "--prune")
    }

    /**
     * Ensures a local branch exists, creating a tracking branch from remote if missing locally.
     */
    fun ensureLocalBranch(branch: String, remote: String): Boolean {
        if (branchExistsLocal(branch)) {
            return true
        }
        if (hasRemote(remote) && branchExistsRemote(remote, branch)) {
            runOrThrow("branch", "--track", branch, "$remote/$branch")
            return true
        }
        return false
    }

    fun checkout(branch: String) {
        runOrThrow("checkout", branch)
    }

    fun checkoutNewBranch(branch: String) {
        runOrThrow("checkout", "-b", branch)
    }

    fun pullFastForwardOnly(remote: String, branch: String) {
        runOrThrow("pull", "--ff-only", remote, branch)
    }

    fun stashPush(message: String) {
        runOrThrow("stash", "push", "-u", "-m", message)
    }

    fun stashPop() {
        runOrThrow("stash", "pop")
    }

    fun merge(branch: String, noFastForward: Boolean): MergeOutcome {
        val args = buildList {
            add("merge")
            if (noFastForward) add("--no-ff")
            add("--no-edit")
            add(branch)
        }
        val res = runRaw(*args.toTypedArray())
        val output = "${res.stdout}\n${res.stderr}".trim()

        if (res.exitCode == 0) {
            return MergeOutcome(ok = true, conflicted = false, conflictedFiles = emptyList(), output = output)
        }

        val merging = isMergeInProgress()
        val conflicts = getConflictedFiles()
        if (merging || conflicts.isNotEmpty()) {
            return MergeOutcome(ok = false, conflicted = true, conflictedFiles = conflicts, output = output)
        }

        throw GitRunnerException("git ${args.joinToString(" ")} 실패: $output", args, res.exitCode, res.stdout, res.stderr)
    }

    fun mergeAbort() {
        runOrThrow("merge", "--abort")
    }

    fun commitMerge() {
        runOrThrow("commit", "--no-edit")
    }

    fun push(remote: String, branch: String) {
        runOrThrow("push", "-u", remote, branch)
    }

    fun deleteLocalBranch(branch: String, force: Boolean = false) {
        runOrThrow("branch", if (force) "-D" else "-d", branch)
    }

    fun deleteRemoteBranch(remote: String, branch: String) {
        runOrThrow("push", remote, "--delete", branch)
    }

    fun getAheadCommits(base: String, head: String): List<String> {
        return runOrThrow("log", "--oneline", "$base..$head")
            .stdout
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toList()
    }

    companion object {
        fun hasMergeHeadFile(startPath: Path): Boolean {
            val gitDir = resolveGitDir(startPath) ?: return false
            return Files.isRegularFile(gitDir.resolve("MERGE_HEAD"))
        }

        fun getCurrentBranchFast(startPath: Path): String? {
            val gitDir = resolveGitDir(startPath) ?: return null
            val headFile = gitDir.resolve("HEAD")
            if (!Files.isRegularFile(headFile)) {
                return null
            }
            return runCatching {
                val content = Files.readString(headFile, StandardCharsets.UTF_8).trim()
                val prefix = "ref: refs/heads/"
                if (content.startsWith(prefix)) {
                    content.removePrefix(prefix).trim().takeIf { it.isNotEmpty() }
                } else {
                    null
                }
            }.getOrNull()
        }

        private fun resolveGitDir(startPath: Path): Path? {
            var current: Path? = startPath.toAbsolutePath().normalize()
            var depth = 0
            while (current != null && depth < 64) {
                val dotGit = current.resolve(".git")
                if (Files.isDirectory(dotGit)) {
                    return dotGit
                }
                if (Files.isRegularFile(dotGit)) {
                    return resolveGitDirFromFile(current, dotGit)
                }
                current = current.parent
                depth++
            }
            return null
        }

        private fun resolveGitDirFromFile(repoDir: Path, dotGitFile: Path): Path? {
            return runCatching {
                val firstLine = Files.readAllLines(dotGitFile, StandardCharsets.UTF_8)
                    .firstOrNull { it.isNotBlank() }
                    ?.trim()
                    ?: return@runCatching null
                if (!firstLine.startsWith("gitdir:", ignoreCase = true)) {
                    return@runCatching null
                }
                val rawTarget = firstLine.substringAfter(":").trim()
                if (rawTarget.isEmpty()) {
                    return@runCatching null
                }
                val targetPath = Path.of(rawTarget)
                if (targetPath.isAbsolute) targetPath.normalize() else repoDir.resolve(targetPath).normalize()
            }.getOrNull()
        }
    }
}
