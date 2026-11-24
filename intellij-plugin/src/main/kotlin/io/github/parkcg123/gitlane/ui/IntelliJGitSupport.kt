package io.github.parkcg123.gitlane.ui

import com.intellij.dvcs.repo.Repository
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import git4idea.repo.GitRepositoryManager
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.naming.BranchNamer
import java.nio.file.Path

object IntelliJGitSupport {
    const val NOTIFICATION_GROUP_ID = "GitLane"

    fun isMergeInProgressFast(project: Project): Boolean {
        if (project.isDisposed) {
            return false
        }
        return runCatching {
            val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            if (repo?.state == Repository.State.MERGING) {
                return@runCatching true
            }
            val root = repo?.root?.toNioPath()
                ?: project.basePath?.let { Path.of(it) }
                ?: return@runCatching false
            GitRunner.hasMergeHeadFile(root)
        }.getOrDefault(false)
    }

    fun isOnTaskBranchFast(project: Project): Boolean {
        if (project.isDisposed) {
            return false
        }
        return runCatching {
            val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            val root = repo?.root?.toNioPath() ?: project.basePath?.let { Path.of(it) }
            val branch = repo?.currentBranchName
                ?: root?.let { GitRunner.getCurrentBranchFast(it) }
                ?: return@runCatching false
            val config = resolveQuickConfig(project)
            !BranchNamer.isProtectedBranch(branch, config)
        }.getOrDefault(false)
    }

    fun resolveQuickConfig(project: Project): FlowConfig {
        if (project.isDisposed) {
            return FlowConfig()
        }
        val root = runCatching {
            GitRepositoryManager.getInstance(project)
                .repositories
                .firstOrNull()
                ?.root
                ?.toNioPath()
                ?: project.basePath?.let { Path.of(it) }
        }.getOrNull() ?: return FlowConfig()
        return runCatching { FlowConfig.loadFromRepo(root) }.getOrDefault(FlowConfig())
    }

    fun resolveRepoRoot(project: Project): Path? {
        if (project.isDisposed) {
            return null
        }
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
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(repoRoot)?.let { rootVf ->
            VfsUtil.markDirtyAndRefresh(true, true, true, rootVf)
        }
        GitRepositoryManager.getInstance(project).updateAllRepositories()
        FlowStatusBarWidgetFactory.refreshWidget(project)
    }

    fun notify(project: Project, content: String, type: NotificationType) {
        if (project.isDisposed) {
            return
        }
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification("GitLane", content, type)
            .notify(project)
    }
}
