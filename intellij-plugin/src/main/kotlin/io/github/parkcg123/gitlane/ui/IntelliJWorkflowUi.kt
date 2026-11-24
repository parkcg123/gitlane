package io.github.parkcg123.gitlane.ui

import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.InputValidatorEx
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.CheckBoxList
import com.intellij.ui.components.JBScrollPane
import git4idea.merge.GitConflictResolver
import git4idea.repo.GitRepositoryManager
import io.github.parkcg123.gitlane.naming.BranchNamer
import io.github.parkcg123.gitlane.workflow.ConflictPromptChoice
import io.github.parkcg123.gitlane.workflow.MergeTargetChoice
import io.github.parkcg123.gitlane.workflow.MergeToDevelopChoice
import io.github.parkcg123.gitlane.workflow.PendingConflictContext
import io.github.parkcg123.gitlane.workflow.PendingConflictStateService
import io.github.parkcg123.gitlane.workflow.StartBaseChoice
import io.github.parkcg123.gitlane.workflow.WorkflowUi
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

class IntelliJWorkflowUi(
    private val project: Project,
    private val repoRoot: Path,
    private val separator: String,
    private val useDevelopBranch: Boolean = true,
    private val repoLabel: String? = null,
) : WorkflowUi {

    private fun dialogTitle(suffix: String): String {
        return if (repoLabel != null) "GitLane [$repoLabel] — $suffix" else "GitLane — $suffix"
    }

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

    override fun promptStartBaseBranch(
        developBranch: String,
        masterBranch: String,
    ): StartBaseChoice {
        return runOnEdtAndGet {
            val choiceIndex = Messages.showDialog(
                project,
                "새 작업 브랜치를 어느 기준 브랜치에서 분기할까요?",
                dialogTitle("① 작업 시작 기준 브랜치"),
                arrayOf(
                    "$developBranch (일반 작업 · 기본)",
                    "$masterBranch (운영 핫픽스)",
                    "취소",
                ),
                0,
                Messages.getQuestionIcon(),
            )
            when (choiceIndex) {
                0 -> StartBaseChoice.DEVELOP
                1 -> StartBaseChoice.MASTER
                else -> StartBaseChoice.CANCEL
            }
        }
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
                dialogTitle("① 작업 시작"),
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
                dialogTitle("① 작업 시작"),
                "임시 저장(Stash) 후 진행",
                "취소",
                Messages.getWarningIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmPopStash(taskBranch: String): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "임시 저장(Stash)한 변경사항을 '$taskBranch' 브랜치로 바로 복원(Stash Pop)할까요?",
                dialogTitle("① 작업 시작"),
                "변경사항 복원",
                "나중에",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmExistingBranch(branchName: String): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "'$branchName' 브랜치가 이미 존재합니다. 해당 브랜치로 이동할까요?",
                dialogTitle("① 작업 시작"),
                "기존 브랜치로 이동",
                "취소",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun promptMergeTarget(
        taskBranch: String,
        developBranch: String,
        masterBranch: String,
    ): MergeTargetChoice {
        return runOnEdtAndGet {
            val choiceIndex = Messages.showDialog(
                project,
                "'$taskBranch' 작업 브랜치를 어느 브랜치에 반영할까요?",
                dialogTitle("② 작업 반영 대상 선택"),
                arrayOf(
                    "$developBranch (스테이지만)",
                    "$masterBranch (운영만)",
                    "$developBranch + $masterBranch (둘 다)",
                    "취소",
                ),
                0,
                Messages.getQuestionIcon(),
            )
            when (choiceIndex) {
                0 -> MergeTargetChoice.DEVELOP
                1 -> MergeTargetChoice.MASTER
                2 -> MergeTargetChoice.BOTH
                else -> MergeTargetChoice.CANCEL
            }
        }
    }

    override fun confirmMergeToDevelop(
        taskBranch: String,
        developBranch: String,
        commitCount: Int,
        aheadCommits: List<String>,
    ): MergeToDevelopChoice {
        val title = if (useDevelopBranch) {
            dialogTitle("② 작업 반영 ($taskBranch → $developBranch)")
        } else {
            dialogTitle("② 운영 바로 반영 ($taskBranch → $developBranch)")
        }
        val commitDesc = if (developBranch.contains(" + ")) "최대 ${commitCount}개" else "${commitCount}개"
        val previewLines = aheadCommits.take(5).map { "• $it" }.toMutableList()
        if (aheadCommits.size > 5) {
            previewLines.add("... 외 ${aheadCommits.size - 5}건")
        }
        val message = buildString {
            append("'$taskBranch'의 ${commitDesc} 커밋을 '$developBranch'에 어떻게 반영할까요?")
            if (previewLines.isNotEmpty()) {
                append("\n\n")
                append(previewLines.joinToString("\n"))
            }
        }
        return runOnEdtAndGet {
            val choiceIndex = Messages.showDialog(
                project,
                message,
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

    override fun confirmDeleteAlreadyMergedBranch(
        taskBranch: String,
        targetSummary: String,
    ): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "'$taskBranch'는 이미 '$targetSummary'에 반영되어 병합할 새 커밋이 없습니다. 작업 브랜치를 삭제할까요?",
                dialogTitle("작업 브랜치 정리"),
                "브랜치 삭제",
                "유지",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }

    override fun confirmDeleteTaskBranch(
        taskBranch: String,
        unmergedCommitCount: Int,
        returnBranch: String,
    ): Boolean {
        val message = if (unmergedCommitCount > 0) {
            "'$taskBranch'에 아직 병합되지 않은 커밋이 ${unmergedCommitCount}개 있습니다.\n강제 삭제(-D)하고 '$returnBranch'로 이동할까요? (복구 어려움)"
        } else {
            "'$taskBranch' 브랜치를 삭제하고 '$returnBranch'로 이동할까요?"
        }
        val confirmText = if (unmergedCommitCount > 0) "강제 삭제" else "브랜치 삭제"
        val icon = if (unmergedCommitCount > 0) Messages.getWarningIcon() else Messages.getQuestionIcon()
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                message,
                dialogTitle("작업 브랜치 삭제"),
                confirmText,
                "취소",
                icon,
            )
            answer == Messages.YES
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
                dialogTitle("③ 운영 반영 ($developBranch → $masterBranch)"),
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
                dialogTitle("머지 취소"),
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
                dialogTitle("머지 충돌 발생"),
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
        IntelliJGitSupport.notify(project, message, NotificationType.INFORMATION, repoLabel)
    }

    override fun showWarning(message: String) {
        IntelliJGitSupport.notify(project, message, NotificationType.WARNING, repoLabel)
    }

    override fun showError(message: String) {
        IntelliJGitSupport.notify(project, message, NotificationType.ERROR, repoLabel)
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
                repoLabel,
            )
        }
    }

    override fun getPendingConflict(): PendingConflictContext? {
        return project.service<PendingConflictStateService>().get(repoRoot)
    }

    override fun setPendingConflict(context: PendingConflictContext?) {
        project.service<PendingConflictStateService>().set(repoRoot, context)
    }

    override fun promptSelectBranchesToDelete(branches: List<String>): List<String>? {
        return runOnEdtAndGet {
            val checkList = CheckBoxList<String>()
            branches.forEach { branch ->
                checkList.addItem(branch, branch, true)
            }
            val dialog = object : DialogWrapper(project) {
                init {
                    title = dialogTitle("완료된 작업 브랜치 일괄 정리")
                    setOKButtonText("선택 브랜치 삭제")
                    setCancelButtonText("취소")
                    init()
                }

                override fun createCenterPanel(): javax.swing.JComponent {
                    val panel = javax.swing.JPanel(java.awt.BorderLayout(0, 8))
                    panel.add(
                        javax.swing.JLabel("이미 병합 완료된 작업 브랜치만 표시됩니다. 삭제할 브랜치를 선택하세요."),
                        java.awt.BorderLayout.NORTH,
                    )
                    val scrollPane = JBScrollPane(checkList)
                    scrollPane.preferredSize = java.awt.Dimension(420, 220)
                    panel.add(scrollPane, java.awt.BorderLayout.CENTER)
                    return panel
                }
            }
            if (!dialog.showAndGet()) {
                null
            } else {
                branches.filterIndexed { index, _ -> checkList.isItemSelected(index) }
            }
        }
    }

    fun confirmCompleteResolvedMerge(): Boolean {
        return runOnEdtAndGet {
            val answer = Messages.showYesNoDialog(
                project,
                "모든 충돌이 해결되었습니다. 지금 병합 커밋 및 푸시를 완료할까요?",
                dialogTitle("충돌 해결 완료"),
                "커밋 및 푸시 완료",
                "나중에 완료",
                Messages.getQuestionIcon(),
            )
            answer == Messages.YES
        }
    }
}
