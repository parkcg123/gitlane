package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport

class ResolveConflictsAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && IntelliJGitSupport.isMergeInProgressFast(project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        WorkflowActionSupport.run(
            project,
            "GitLane: 충돌 해결 창 열기",
            offerContinueIfResolved = true,
        ) { engine ->
            engine.openConflictResolver()
        }
    }
}
