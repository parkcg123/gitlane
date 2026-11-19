package io.github.parkcg123.gitlane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport
import io.github.parkcg123.gitlane.ui.IntelliJWorkflowUi
import io.github.parkcg123.gitlane.workflow.WorkflowEngine
import io.github.parkcg123.gitlane.workflow.WorkflowResult
import io.github.parkcg123.gitlane.workflow.WorkflowStatus

object WorkflowActionSupport {
    fun run(
        project: Project,
        title: String,
        offerContinueIfResolved: Boolean = false,
        operation: (WorkflowEngine) -> WorkflowResult,
    ) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                val repoRoot = IntelliJGitSupport.resolveRepoRoot(project)
                if (repoRoot == null) {
                    IntelliJGitSupport.notify(
                        project,
                        "열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.",
                        NotificationType.WARNING,
                    )
                    return
                }

                try {
                    val loaded = FlowConfig.loadWithWarning(repoRoot)
                    loaded.warning?.let { warning ->
                        IntelliJGitSupport.notify(project, warning, NotificationType.WARNING)
                    }

                    val git = GitRunner(repoRoot)
                    val ui = IntelliJWorkflowUi(
                        project,
                        repoRoot,
                        loaded.config.separator,
                        loaded.config.useDevelopBranch,
                    )
                    val engine = WorkflowEngine(git, ui, loaded.config)

                    val result = operation(engine)

                    if (
                        offerContinueIfResolved &&
                        git.isMergeInProgress() &&
                        git.getConflictedFiles().isEmpty() &&
                        (result.status == WorkflowStatus.SUCCESS || result.status == WorkflowStatus.CONFLICT) &&
                        ui.confirmCompleteResolvedMerge()
                    ) {
                        engine.continueAfterConflict()
                    }
                } catch (e: Exception) {
                    val detail = e.message ?: e::class.java.simpleName
                    IntelliJGitSupport.notify(project, "GitLane 오류: $detail", NotificationType.ERROR)
                } finally {
                    IntelliJGitSupport.refreshIdeState(project, repoRoot)
                }
            }
        })
    }
}
