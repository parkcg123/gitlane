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
import java.nio.file.Path

object WorkflowActionSupport {
    fun run(
        project: Project,
        title: String,
        offerContinueIfResolved: Boolean = false,
        explicitRepoRoot: Path? = null,
        explicitRepoLabel: String? = null,
        operation: (WorkflowEngine) -> WorkflowResult,
    ) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                val allRepos = IntelliJGitSupport.discoverReposFast(project)
                val activeRepo = IntelliJGitSupport.resolveActiveRepo(project, allRepos)
                val repoRoot = explicitRepoRoot ?: activeRepo?.root ?: IntelliJGitSupport.resolveRepoRoot(project)
                if (repoRoot == null) {
                    IntelliJGitSupport.notify(
                        project,
                        "열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.",
                        NotificationType.WARNING,
                    )
                    return
                }

                IntelliJGitSupport.rememberSelectedRepo(project, repoRoot)
                val effectiveLabel = explicitRepoLabel
                    ?: if (allRepos.size >= 2) {
                        allRepos.firstOrNull { it.root == repoRoot }?.label ?: activeRepo?.label
                    } else {
                        null
                    }

                try {
                    val loaded = FlowConfig.loadWithWarning(repoRoot)
                    loaded.warning?.let { warning ->
                        IntelliJGitSupport.notify(project, warning, NotificationType.WARNING, effectiveLabel)
                    }

                    val git = GitRunner(repoRoot)
                    val ui = IntelliJWorkflowUi(
                        project,
                        repoRoot,
                        loaded.config.separator,
                        loaded.config.useDevelopBranch,
                        effectiveLabel,
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
                    IntelliJGitSupport.notify(project, "GitLane 오류: $detail", NotificationType.ERROR, effectiveLabel)
                } finally {
                    IntelliJGitSupport.refreshIdeState(project, repoRoot)
                }
            }
        })
    }
}
