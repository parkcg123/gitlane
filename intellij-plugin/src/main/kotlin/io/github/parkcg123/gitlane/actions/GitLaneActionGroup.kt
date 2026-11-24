package io.github.parkcg123.gitlane.actions

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import io.github.parkcg123.gitlane.git.DiscoveredRepo
import io.github.parkcg123.gitlane.naming.BranchNamer
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport
import io.github.parkcg123.gitlane.workflow.WorkflowEngine
import io.github.parkcg123.gitlane.workflow.WorkflowResult

class GitLaneActionGroup : ActionGroupCompat() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val project = e?.project ?: return AnAction.EMPTY_ARRAY
        val repos = IntelliJGitSupport.discoverReposFast(project)
        if (repos.size <= 1) {
            return buildStaticSingleRepoActions()
        }

        val activeRepo = IntelliJGitSupport.resolveActiveRepo(project, repos)
        val result = mutableListOf<AnAction>()

        for (repo in repos) {
            val merging = IntelliJGitSupport.isMergeInProgressFast(project, repo.root)
            val branch = IntelliJGitSupport.getCurrentBranchFast(project, repo.root)
            val config = IntelliJGitSupport.resolveQuickConfig(project, repo.root)
            val isActive = repo.root == activeRepo?.root

            val statusText = when {
                merging -> "머지 충돌 중"
                branch == null -> "HEAD 분리됨"
                branch == config.masterBranch -> "$branch (운영)"
                config.useDevelopBranch && branch == config.developBranch -> "$branch (스테이지)"
                else -> branch
            }
            val activeSuffix = if (isActive) " (현재)" else ""
            result.add(Separator.create("${repo.label} · $statusText$activeSuffix"))

            if (merging) {
                result.add(
                    RepoScopedAction(
                        repo = repo,
                        text = "[${repo.label}] 충돌 해결 창 열기 (3-Way Merge)",
                        description = "${repo.label} 저장소의 충돌 파일에 대해 3-Way Merge 창을 엽니다.",
                        taskTitle = "GitLane [${repo.label}]: 충돌 해결 창 열기",
                        offerContinueIfResolved = true,
                        operation = { it.openConflictResolver() },
                    ),
                )
                result.add(
                    RepoScopedAction(
                        repo = repo,
                        text = "[${repo.label}] 충돌 해결 완료 (커밋 & 푸시)",
                        description = "${repo.label} 저장소의 충돌 해결 후 병합 커밋 및 푸시를 완료합니다.",
                        taskTitle = "GitLane [${repo.label}]: 충돌 해결 완료",
                        offerContinueIfResolved = false,
                        operation = { it.continueAfterConflict() },
                    ),
                )
                result.add(
                    RepoScopedAction(
                        repo = repo,
                        text = "[${repo.label}] 머지 취소 (원복)",
                        description = "${repo.label} 저장소의 진행 중인 병합을 취소합니다.",
                        taskTitle = "GitLane [${repo.label}]: 머지 취소",
                        offerContinueIfResolved = false,
                        operation = { it.abortMerge() },
                    ),
                )
            } else {
                result.add(
                    RepoScopedAction(
                        repo = repo,
                        text = "[${repo.label}] ① 작업 시작 (브랜치 생성)",
                        description = "${repo.label} (${config.taskBaseBranch()} → 작업 브랜치)",
                        taskTitle = "GitLane [${repo.label}]: ① 작업 시작",
                        offerContinueIfResolved = false,
                        operation = { it.startTask() },
                    ),
                )

                val onTaskBranch = branch != null && !BranchNamer.isProtectedBranch(branch, config)
                if (onTaskBranch) {
                    val mergeLabel = if (config.useDevelopBranch) {
                        "[${repo.label}] ② 작업 반영 (병합 / 완료)"
                    } else {
                        "[${repo.label}] ② 운영 반영 (${config.masterBranch} 바로 병합)"
                    }
                    result.add(
                        RepoScopedAction(
                            repo = repo,
                            text = mergeLabel,
                            description = "${repo.label}: $branch 반영",
                            taskTitle = "GitLane [${repo.label}]: ② 작업 반영",
                            offerContinueIfResolved = true,
                            operation = { it.mergeToDevelop() },
                        ),
                    )
                    result.add(
                        RepoScopedAction(
                            repo = repo,
                            text = "[${repo.label}] 작업 브랜치 삭제",
                            description = "${repo.label}: $branch 삭제 후 복귀",
                            taskTitle = "GitLane [${repo.label}]: 작업 브랜치 삭제",
                            offerContinueIfResolved = false,
                            operation = { it.deleteTaskBranch() },
                        ),
                    )
                }

                if (config.useDevelopBranch) {
                    result.add(
                        RepoScopedAction(
                            repo = repo,
                            text = "[${repo.label}] ③ 운영 반영 (${config.developBranch} → ${config.masterBranch})",
                            description = "${repo.label}: ${config.developBranch} → ${config.masterBranch}",
                            taskTitle = "GitLane [${repo.label}]: ③ 운영 반영",
                            offerContinueIfResolved = true,
                            operation = { it.releaseToMaster() },
                        ),
                    )
                }
            }
        }

        return result.toTypedArray()
    }

    private fun buildStaticSingleRepoActions(): Array<AnAction> {
        val manager = ActionManager.getInstance()
        val ids = listOf(
            "GitLane.StartTask",
            "GitLane.MergeToDevelop",
            "GitLane.DeleteTaskBranch",
            "GitLane.ReleaseToMaster",
        )
        val conflictIds = listOf(
            "GitLane.ResolveConflicts",
            "GitLane.ContinueMerge",
            "GitLane.AbortMerge",
        )
        val actions = mutableListOf<AnAction>()
        ids.forEach { id -> manager.getAction(id)?.let { actions.add(it) } }
        actions.add(Separator.getInstance())
        conflictIds.forEach { id -> manager.getAction(id)?.let { actions.add(it) } }
        return actions.toTypedArray()
    }

    private class RepoScopedAction(
        private val repo: DiscoveredRepo,
        text: String,
        description: String,
        private val taskTitle: String,
        private val offerContinueIfResolved: Boolean,
        private val operation: (WorkflowEngine) -> WorkflowResult,
    ) : DumbAwareAction(text, description, null) {
        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) {
            val project = e.project ?: return
            WorkflowActionSupport.run(
                project = project,
                title = taskTitle,
                offerContinueIfResolved = offerContinueIfResolved,
                explicitRepoRoot = repo.root,
                explicitRepoLabel = repo.label,
                operation = operation,
            )
        }
    }
}

abstract class ActionGroupCompat : com.intellij.openapi.actionSystem.ActionGroup(), com.intellij.openapi.project.DumbAware
