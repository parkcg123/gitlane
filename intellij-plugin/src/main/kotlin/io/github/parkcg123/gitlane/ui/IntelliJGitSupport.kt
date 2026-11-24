package io.github.parkcg123.gitlane.ui

import com.intellij.dvcs.repo.Repository
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryManager
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.DiscoveredRepo
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.git.RepoDiscovery
import io.github.parkcg123.gitlane.naming.BranchNamer
import java.nio.file.Path

object IntelliJGitSupport {
    const val NOTIFICATION_GROUP_ID = "GitLane"

    fun discoverReposFast(project: Project): List<DiscoveredRepo> {
        if (project.isDisposed) {
            return emptyList()
        }
        return runCatching {
            val roots = LinkedHashSet<Path>()
            GitRepositoryManager.getInstance(project).repositories.forEach { repo ->
                runCatching { repo.root.toNioPath() }.getOrNull()?.let { roots.add(it) }
            }
            val workspaceRoots = mutableListOf<Path>()
            project.basePath?.let { baseStr ->
                val basePath = Path.of(baseStr)
                workspaceRoots.add(basePath)
                roots.addAll(RepoDiscovery.scanNestedGitRepos(basePath, maxDepth = 2))
            }
            RepoDiscovery.buildRepoLabels(roots, workspaceRoots)
        }.getOrDefault(emptyList())
    }

    fun rememberActiveEditorFile(project: Project, filePath: Path?) {
        if (!project.isDisposed) {
            project.service<RepoSelectionService>().lastActiveEditorFile = filePath
        }
    }

    fun rememberSelectedRepo(project: Project, repoRoot: Path) {
        if (!project.isDisposed) {
            project.service<RepoSelectionService>().lastSelectedRepoRoot =
                RepoDiscovery.normalizePath(repoRoot)
        }
    }

    fun resolveActiveRepo(
        project: Project,
        repos: List<DiscoveredRepo> = discoverReposFast(project),
    ): DiscoveredRepo? {
        if (project.isDisposed || repos.isEmpty()) {
            return null
        }
        val selection = project.service<RepoSelectionService>()
        val activeFile = selection.lastActiveEditorFile
            ?: runCatching {
                FileEditorManager.getInstance(project)
                    .selectedFiles
                    .firstOrNull { it.isInLocalFileSystem }
                    ?.toNioPath()
            }.getOrNull()

        RepoDiscovery.findContainingRepo(activeFile, repos)?.let { return it }

        val remembered = selection.lastSelectedRepoRoot
        if (remembered != null) {
            repos.firstOrNull { it.root == remembered }?.let { return it }
        }
        return repos.firstOrNull()
    }

    private fun findGitRepositoryForRoot(project: Project, repoRoot: Path): GitRepository? {
        val normalized = RepoDiscovery.normalizePath(repoRoot)
        return GitRepositoryManager.getInstance(project).repositories.firstOrNull { repo ->
            runCatching { RepoDiscovery.normalizePath(repo.root.toNioPath()) == normalized }
                .getOrDefault(false)
        }
    }

    fun isMergeInProgressFast(project: Project, repoRoot: Path? = null): Boolean {
        if (project.isDisposed) {
            return false
        }
        return runCatching {
            val targetRoot = repoRoot?.let { RepoDiscovery.normalizePath(it) }
                ?: resolveActiveRepo(project)?.root
            val repo = if (targetRoot != null) {
                findGitRepositoryForRoot(project, targetRoot)
            } else {
                GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            }
            if (repo?.state == Repository.State.MERGING) {
                return@runCatching true
            }
            val root = targetRoot
                ?: repo?.root?.toNioPath()
                ?: project.basePath?.let { Path.of(it) }
                ?: return@runCatching false
            GitRunner.hasMergeHeadFile(root)
        }.getOrDefault(false)
    }

    fun getCurrentBranchFast(project: Project, repoRoot: Path? = null): String? {
        if (project.isDisposed) {
            return null
        }
        return runCatching {
            val targetRoot = repoRoot?.let { RepoDiscovery.normalizePath(it) }
                ?: resolveActiveRepo(project)?.root
                ?: return@runCatching null
            val repo = findGitRepositoryForRoot(project, targetRoot)
            repo?.currentBranchName ?: GitRunner.getCurrentBranchFast(targetRoot)
        }.getOrNull()
    }

    fun isOnTaskBranchFast(project: Project, repoRoot: Path? = null): Boolean {
        if (project.isDisposed) {
            return false
        }
        return runCatching {
            val targetRoot = repoRoot?.let { RepoDiscovery.normalizePath(it) }
                ?: resolveActiveRepo(project)?.root
                ?: return@runCatching false
            val branch = getCurrentBranchFast(project, targetRoot) ?: return@runCatching false
            val config = resolveQuickConfig(project, targetRoot)
            !BranchNamer.isProtectedBranch(branch, config)
        }.getOrDefault(false)
    }

    fun resolveQuickConfig(project: Project, repoRoot: Path? = null): FlowConfig {
        if (project.isDisposed) {
            return FlowConfig()
        }
        val root = repoRoot?.let { RepoDiscovery.normalizePath(it) }
            ?: resolveActiveRepo(project)?.root
            ?: project.basePath?.let { Path.of(it) }
            ?: return FlowConfig()
        return runCatching { FlowConfig.loadFromRepo(root) }.getOrDefault(FlowConfig())
    }

    fun resolveRepoRoot(project: Project): Path? {
        if (project.isDisposed) {
            return null
        }
        resolveActiveRepo(project)?.let { return it.root }
        val repoFromManager = GitRepositoryManager.getInstance(project)
            .repositories
            .firstOrNull()
            ?.root
            ?.toNioPath()
        if (repoFromManager != null) {
            return repoFromManager
        }
        val basePath = project.basePath ?: return null
        return runCatching { GitRunner(Path.of(basePath)).getRepoRoot() }.getOrNull()
    }

    fun refreshIdeState(project: Project, repoRoot: Path) {
        if (project.isDisposed) {
            return
        }
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            app.executeOnPooledThread { refreshIdeState(project, repoRoot) }
            return
        }
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(repoRoot)?.let { rootVf ->
            VfsUtil.markDirtyAndRefresh(true, true, true, rootVf)
        }
        GitRepositoryManager.getInstance(project).updateAllRepositories()
        FlowStatusBarWidgetFactory.refreshWidget(project)
    }

    fun notify(
        project: Project,
        content: String,
        type: NotificationType,
        repoLabel: String? = null,
    ) {
        if (project.isDisposed) {
            return
        }
        val notificationTitle = if (repoLabel != null) "GitLane [$repoLabel]" else "GitLane"
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification(notificationTitle, content, type)
            .notify(project)
    }
}
