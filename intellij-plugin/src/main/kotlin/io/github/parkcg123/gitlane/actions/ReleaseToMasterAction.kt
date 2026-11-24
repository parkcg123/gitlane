package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport

class ReleaseToMasterAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        if (project == null || IntelliJGitSupport.isMergeInProgressFast(project)) {
            e.presentation.isEnabledAndVisible = false
            return
        }
        e.presentation.isEnabledAndVisible = IntelliJGitSupport.resolveQuickConfig(project).useDevelopBranch
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        WorkflowActionSupport.run(
            project,
            "GitLane: ③ 운영 반영",
            offerContinueIfResolved = true,
        ) { engine ->
            engine.releaseToMaster()
        }
    }
}
