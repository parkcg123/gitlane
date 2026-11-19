package io.github.parkcg123.gitlane.ui

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import git4idea.repo.GitRepositoryManager
import io.github.parkcg123.gitlane.git.GitRunner
import java.nio.file.Path

object IntelliJGitSupport {
    const val NOTIFICATION_GROUP_ID = "GitLane"

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
