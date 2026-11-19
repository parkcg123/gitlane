package io.github.parkcg123.gitlane.ui

import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidatorEx
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import git4idea.merge.GitConflictResolver
import git4idea.repo.GitRepositoryManager
import io.github.parkcg123.gitlane.naming.BranchNamer
import io.github.parkcg123.gitlane.workflow.ConflictPromptChoice
import io.github.parkcg123.gitlane.workflow.MergeToDevelopChoice
import io.github.parkcg123.gitlane.workflow.PendingConflictContext
import io.github.parkcg123.gitlane.workflow.PendingConflictStateService
import io.github.parkcg123.gitlane.workflow.WorkflowUi
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

class IntelliJWorkflowUi(
    private val project: Project,
    private val repoRoot: Path,
    private val separator: String,
    private val useDevelopBranch: Boolean = true,
) : WorkflowUi {

    private fun <T> runOnEdtAndGet(block: () -> T): T {
        val resultRef = AtomicReference<T>()
        val errorRef = AtomicReference<Throwable?>()
        ApplicationManager.getApplication().invokeAndWait({
            try {
                resultRef.set(block())
            } catch (t: Throwable) {
                errorRef.set(t)
            }
        }, ModalityState.any())
        errorRef.get()?.let { throw it }
        return resultRef.get()
    }

    override fun promptTaskName(datePrefix: String): String? {
        val validator = object : InputValidatorEx {
            override fun getErrorText(inputString: String): String? {
                if (inputString.trim().isEmpty()) {
                    return null
                }
                return BranchNamer.validateTaskName(inputString, separator)
            }

            override fun checkInput(inputString: String): Boolean {
                return BranchNamer.validateTaskName(inputString, separator) == null
            }

            override fun canClose(inputString: String): Boolean = checkInput(inputString)
        }

        return runOnEdtAndGet {
            Messages.showInputDialog(
                project,
                "생성될 브랜치 접두사: $datePrefix<작업명>",
                "GitLane — ① 작업 시작",
                Messages.getQuestionIcon(),
                "",
                validator,
            )
        }
    }

    override fun confirmDirtyStart(): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "커밋되지 않은 변경사항이 있습니다. 임시 저장(Stash) 후 새 작업을 시작할까요?",
                "GitLane — ① 작업 시작",
                "임시 저장(Stash) 후 진행",
                "취소",
                Messages.getWarningIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmExistingBranch(branchName: String): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "'$branchName' 브랜치가 이미 존재합니다. 해당 브랜치로 이동할까요?",
                "GitLane — ① 작업 시작",
                "기존 브랜치로 이동",
                "취소",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmMergeToDevelop(
        taskBranch: String,
        developBranch: String,
        commitCount: Int,
    ): MergeToDevelopChoice {
        val title = if (useDevelopBranch) {
            "GitLane — ② 스테이지 반영 ($taskBranch → $developBranch)"
        } else {
            "GitLane — ② 운영 바로 반영 ($taskBranch → $developBranch)"
        }
        return runOnEdtAndGet {
            val choiceIndex = Messages.showDialog(
                project,
                "'$taskBranch'의 ${commitCount}개 커밋을 '$developBranch'에 어떻게 반영할까요?",
                title,
                arrayOf("병합 + 푸시 + 브랜치 삭제", "병합 + 푸시 (브랜치 유지)", "취소"),
                0,
                Messages.getQuestionIcon(),
            )
            when (choiceIndex) {
                0 -> MergeToDevelopChoice.DELETE
                1 -> MergeToDevelopChoice.KEEP
                else -> MergeToDevelopChoice.CANCEL
            }
        }
    }

    override fun confirmReleaseToMaster(
        developBranch: String,
        masterBranch: String,
        aheadCommits: List<String>,
    ): Boolean {
        val previewLines = aheadCommits.take(5).map { "• $it" }.toMutableList()
        if (aheadCommits.size > 5) {
            previewLines.add("... 외 ${aheadCommits.size - 5}건")
        }
        val message = buildString {
            append("'$developBranch'의 ${aheadCommits.size}개 커밋을 운영('$masterBranch')에 반영할까요?")
            if (previewLines.isNotEmpty()) {
                append("\n\n")
                append(previewLines.joinToString("\n"))
            }
        }

        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                message,
                "GitLane — ③ 운영 반영 ($developBranch → $masterBranch)",
                "운영(master)에 병합 및 푸시",
                "취소",
                Messages.getWarningIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmAbortMerge(targetBranch: String): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "'$targetBranch' 병합을 취소하고 원래 상태로 복구할까요?",
                "GitLane — 머지 취소",
                "머지 취소 (원복)",
                "닫기",
                Messages.getWarningIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun promptConflictAction(
        context: PendingConflictContext,
        conflictedFiles: List<String>,
    ): ConflictPromptChoice {
        val previewFiles = conflictedFiles.take(5).map { "• $it" }.toMutableList()
        if (conflictedFiles.size > 5) {
            previewFiles.add("... 외 ${conflictedFiles.size - 5}개 파일")
        }
        val message = buildString {
            append("'${context.sourceBranch}' → '${context.targetBranch}' 병합 중 충돌이 발생했습니다 (${conflictedFiles.size}개 파일).")
            if (previewFiles.isNotEmpty()) {
                append("\n\n")
                append(previewFiles.joinToString("\n"))
            }
        }

        return runOnEdtAndGet {
            val choiceIndex = Messages.showDialog(
                project,
                message,
                "GitLane — 머지 충돌 발생",
                arrayOf("충돌 해결 창 열기 (3-Way Merge)", "머지 취소 (원복)", "나중에 해결"),
                0,
                Messages.getWarningIcon(),
            )
            when (choiceIndex) {
                0 -> ConflictPromptChoice.OPEN
                1 -> ConflictPromptChoice.ABORT
                else -> ConflictPromptChoice.LATER
            }
        }
    }

    override fun showInfo(message: String) {
        IntelliJGitSupport.notify(project, message, NotificationType.INFORMATION)
    }

    override fun showWarning(message: String) {
        IntelliJGitSupport.notify(project, message, NotificationType.WARNING)
    }

    override fun showError(message: String) {
        IntelliJGitSupport.notify(project, message, NotificationType.ERROR)
    }

    override fun openConflictedFiles(files: List<String>) {
        if (files.isEmpty()) {
            return
        }

        val fs = LocalFileSystem.getInstance()
        val rootVf = fs.refreshAndFindFileByNioFile(repoRoot)
        rootVf?.refresh(false, true)
        files.forEach { relPath ->
            fs.refreshAndFindFileByNioFile(repoRoot.resolve(relPath))
        }
        GitRepositoryManager.getInstance(project).updateAllRepositories()

        if (rootVf != null) {
            val params = GitConflictResolver.Params(project)
                .setMergeDescription("GitLane 머지 충돌을 해결해 주세요.")
                .setErrorNotificationTitle("GitLane 머지 충돌 미해결")
            GitConflictResolver(project, listOf(rootVf), params).mergeNoProceed()
        } else {
            IntelliJGitSupport.notify(
                project,
                "충돌 파일을 IDE에서 열지 못했습니다. Git 도구 창에서 충돌을 해결해 주세요.",
                NotificationType.WARNING,
            )
        }
    }

    override fun getPendingConflict(): PendingConflictContext? {
        return project.service<PendingConflictStateService>().get(repoRoot)
    }

    override fun setPendingConflict(context: PendingConflictContext?) {
        project.service<PendingConflictStateService>().set(repoRoot, context)
    }

    fun confirmCompleteResolvedMerge(): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "모든 충돌이 해결되었습니다. 지금 병합 커밋 및 푸시를 완료할까요?",
                "GitLane — 충돌 해결 완료",
                "커밋 및 푸시 완료",
                "나중에 완료",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }
}
