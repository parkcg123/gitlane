package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport

class StartTaskAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && !IntelliJGitSupport.isMergeInProgressFast(project)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        WorkflowActionSupport.run(project, "GitLane: ① 작업 시작") { engine ->
            engine.startTask()
        }
    }
}
