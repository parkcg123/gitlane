package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport

class CleanupMergedBranchesAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible =
            project != null && !IntelliJGitSupport.isMergeInProgressFast(project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        WorkflowActionSupport.run(project, "GitLane: 완료된 작업 브랜치 정리") { engine ->
            engine.cleanupMergedBranches()
        }
    }
}
