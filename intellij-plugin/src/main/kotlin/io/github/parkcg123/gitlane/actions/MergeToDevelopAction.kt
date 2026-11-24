package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport

class MergeToDevelopAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        if (
            project == null ||
            IntelliJGitSupport.isMergeInProgressFast(project) ||
            !IntelliJGitSupport.isOnTaskBranchFast(project)
        ) {
            e.presentation.isEnabledAndVisible = false
            return
        }
        e.presentation.isEnabledAndVisible = true
        val cfg = IntelliJGitSupport.resolveQuickConfig(project)
        e.presentation.text = if (cfg.useDevelopBranch) {
            "② 작업 반영 (병합 / 완료)"
        } else {
            "② 운영 반영 (${cfg.masterBranch} 바로 병합)"
        }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val cfg = IntelliJGitSupport.resolveQuickConfig(project)
        val taskTitle = if (cfg.useDevelopBranch) "GitLane: ② 작업 반영" else "GitLane: ② 운영 바로 반영"
        WorkflowActionSupport.run(
            project,
            taskTitle,
            offerContinueIfResolved = true,
        ) { engine ->
            engine.mergeToDevelop()
        }
    }
}
