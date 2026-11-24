package io.github.parkcg123.gitlane.workflow

import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.naming.BranchNamer
import java.time.LocalDate

enum class WorkflowStatus {
    SUCCESS,
    CANCELLED,
    BLOCKED,
    CONFLICT,
    NOOP,
}

enum class MergeTargetChoice {
    DEVELOP,
    MASTER,
    BOTH,
    CANCEL,
}

enum class MergeToDevelopChoice {
    DELETE,
    KEEP,
    CANCEL,
}

enum class ConflictPromptChoice {
    OPEN,
    ABORT,
    LATER,
}

data class WorkflowResult(
    val status: WorkflowStatus,
    val message: String,
    val branch: String? = null,
    val conflictedFiles: List<String> = emptyList(),
)

interface WorkflowUi {
    fun promptTaskName(datePrefix: String): String?
    fun confirmDirtyStart(): Boolean
    fun confirmExistingBranch(branchName: String): Boolean
    fun promptMergeTarget(taskBranch: String, developBranch: String, masterBranch: String): MergeTargetChoice
    fun confirmMergeToDevelop(taskBranch: String, developBranch: String, commitCount: Int): MergeToDevelopChoice
    fun confirmDeleteAlreadyMergedBranch(taskBranch: String, targetSummary: String): Boolean
    fun confirmDeleteTaskBranch(taskBranch: String, unmergedCommitCount: Int, returnBranch: String): Boolean
    fun confirmReleaseToMaster(developBranch: String, masterBranch: String, aheadCommits: List<String>): Boolean
    fun confirmAbortMerge(targetBranch: String): Boolean
    fun promptConflictAction(context: PendingConflictContext, conflictedFiles: List<String>): ConflictPromptChoice
    fun showInfo(message: String)
    fun showWarning(message: String)
    fun showError(message: String)
    fun openConflictedFiles(files: List<String>)
    fun getPendingConflict(): PendingConflictContext?
    fun setPendingConflict(context: PendingConflictContext?)
}

class WorkflowEngine(
    private val git: GitRunner,
    private val ui: WorkflowUi,
    private val config: FlowConfig,
    private val todayProvider: () -> LocalDate = { LocalDate.now() },
) {
    private fun checkInProgressState(): WorkflowResult? {
        if (git.isMergeInProgress()) {
            val msg = "진행 중인 머지가 있습니다. 먼저 충돌을 해결하거나 머지를 취소해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }
        if (git.isRebaseInProgress()) {
            val msg = "진행 중인 리베이스가 있습니다. 먼저 리베이스를 완료하거나 중단해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }
        return null
    }

    private fun syncBranch(branch: String) {
        val hasRemote = git.hasRemote(config.remote)
        if (hasRemote) {
            git.fetch(config.remote)
        }

        val exists = git.ensureLocalBranch(branch, config.remote)
        if (!exists) {
            throw IllegalStateException("브랜치 '$branch'를 로컬 또는 원격('${config.remote}')에서 찾을 수 없습니다.")
        }

        git.checkout(branch)

        if (hasRemote && git.branchExistsRemote(config.remote, branch)) {
            git.pullFastForwardOnly(config.remote, branch)
        }
    }

    private fun pushIfRemoteExists(branch: String): Boolean {
        if (git.hasRemote(config.remote)) {
            git.push(config.remote, branch)
            return true
        }
        return false
    }

    private fun cleanupTaskBranch(taskBranch: String, force: Boolean = false) {
        git.deleteLocalBranch(taskBranch, force)
        if (git.hasRemote(config.remote) && git.branchExistsRemote(config.remote, taskBranch)) {
            try {
                git.deleteRemoteBranch(config.remote, taskBranch)
            } catch (_: Exception) {
                // Remote branch deletion is best-effort after local cleanup.
            }
        }
    }

    private fun restoreBranchIfExists(branch: String?) {
        if (!branch.isNullOrEmpty() && git.branchExistsLocal(branch)) {
            git.checkout(branch)
        }
    }

    private fun executeAbort(ctx: PendingConflictContext?): WorkflowResult {
        git.mergeAbort()
        restoreBranchIfExists(ctx?.returnBranch)
        ui.setPendingConflict(null)
        val msg = "머지를 취소하고 원래 상태로 복구했습니다."
        ui.showInfo(msg)
        return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = ctx?.returnBranch)
    }

    private fun handleMergeConflict(
        context: PendingConflictContext,
        conflictedFiles: List<String>,
    ): WorkflowResult {
        ui.setPendingConflict(context)
        val action = ui.promptConflictAction(context, conflictedFiles)

        if (action == ConflictPromptChoice.ABORT) {
            return executeAbort(context)
        }

        if (action == ConflictPromptChoice.OPEN) {
            ui.openConflictedFiles(conflictedFiles)
        }

        val remaining = if (git.isMergeInProgress()) git.getConflictedFiles() else emptyList()
        val msg = "머지 충돌이 발생했습니다 (${conflictedFiles.size}개 파일). 충돌 해결 후 '충돌 해결 완료'를 실행해 주세요."
        return WorkflowResult(
            status = WorkflowStatus.CONFLICT,
            message = msg,
            branch = context.targetBranch,
            conflictedFiles = remaining,
        )
    }

    /**
     * Action 1: Sync base branch (`develop` or `master` when `useDevelopBranch` is false) and create `YYYYMMDD_<task>` branch.
     */
    fun startTask(): WorkflowResult {
        checkInProgressState()?.let { return it }

        if (git.hasUncommittedChanges()) {
            if (!ui.confirmDirtyStart()) {
                return WorkflowResult(WorkflowStatus.CANCELLED, "작업 시작을 취소했습니다.")
            }
            git.stashPush("gitlane: auto-stash before startTask")
        }

        val baseBranch = config.taskBaseBranch()
        val originalBranch = git.getCurrentBranch()
        syncBranch(baseBranch)

        val today = todayProvider()
        val sep = config.separator.ifEmpty { "_" }
        val datePrefix = "${BranchNamer.formatLocalDate(today)}$sep"
        val rawName = ui.promptTaskName(datePrefix)

        if (rawName == null) {
            if (originalBranch != null && originalBranch != baseBranch) {
                restoreBranchIfExists(originalBranch)
            }
            return WorkflowResult(WorkflowStatus.CANCELLED, "작업 시작을 취소했습니다.")
        }

        val validationError = BranchNamer.validateTaskName(rawName, config.separator)
        if (validationError != null) {
            if (originalBranch != null && originalBranch != baseBranch) {
                restoreBranchIfExists(originalBranch)
            }
            ui.showError(validationError)
            return WorkflowResult(WorkflowStatus.BLOCKED, validationError)
        }

        val taskBranch = BranchNamer.buildTaskBranchName(rawName, config, today)

        if (git.branchExistsLocal(taskBranch)) {
            if (!ui.confirmExistingBranch(taskBranch)) {
                if (originalBranch != null && originalBranch != baseBranch) {
                    restoreBranchIfExists(originalBranch)
                }
                return WorkflowResult(WorkflowStatus.CANCELLED, "작업 시작을 취소했습니다.")
            }
            git.checkout(taskBranch)
            val msg = "기존 작업 브랜치 '${taskBranch}'로 이동했습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = taskBranch)
        }

        git.checkoutNewBranch(taskBranch)
        val msg = "새 작업 브랜치 '${taskBranch}'를 '${baseBranch}'에서 생성했습니다."
        ui.showInfo(msg)
        return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = taskBranch)
    }

    private fun resolveSelectedTargets(choice: MergeTargetChoice): List<String> {
        return when (choice) {
            MergeTargetChoice.DEVELOP -> listOf(config.developBranch)
            MergeTargetChoice.MASTER -> listOf(config.masterBranch)
            MergeTargetChoice.BOTH -> if (config.developBranch == config.masterBranch) {
                listOf(config.masterBranch)
            } else {
                listOf(config.developBranch, config.masterBranch)
            }
            MergeTargetChoice.CANCEL -> emptyList()
        }
    }

    private fun executeTaskMergeTargets(
        taskBranch: String,
        targets: List<String>,
        deleteSourceOnComplete: Boolean,
        alreadySynced: Boolean,
        completedTargets: List<String> = emptyList(),
        anyPushedSoFar: Boolean = false,
    ): WorkflowResult {
        val doneTargets = completedTargets.toMutableList()
        var anyPushed = anyPushedSoFar

        for (i in targets.indices) {
            val target = targets[i]
            val remaining = targets.drop(i + 1)

            if (!alreadySynced) {
                syncBranch(target)
                val remainingAhead = git.getAheadCommits(target, taskBranch)
                if (remainingAhead.isEmpty()) {
                    doneTargets.add(target)
                    continue
                }
            } else if (git.getCurrentBranch() != target) {
                git.checkout(target)
            }

            val mergeResult = git.merge(taskBranch, config.useNoFastForwardMerge)
            if (mergeResult.conflicted) {
                val conflictKind = if (target == config.masterBranch) {
                    PendingConflictContext.KIND_MERGE_TO_MASTER
                } else {
                    PendingConflictContext.KIND_MERGE_TO_DEVELOP
                }
                return handleMergeConflict(
                    PendingConflictContext(
                        targetBranch = target,
                        sourceBranch = taskBranch,
                        returnBranch = taskBranch,
                        deleteSourceOnComplete = deleteSourceOnComplete,
                        kind = conflictKind,
                        remainingTargets = remaining,
                    ),
                    mergeResult.conflictedFiles,
                )
            }

            val pushed = pushIfRemoteExists(target)
            anyPushed = anyPushed || pushed
            doneTargets.add(target)
        }

        var finalBranch = targets.last()
        if (deleteSourceOnComplete) {
            // Delete while HEAD is still on the merged target so `git branch -d` succeeds even for master-only merges.
            cleanupTaskBranch(taskBranch, force = false)
            if (
                config.useDevelopBranch &&
                config.returnToDevelopAfterRelease &&
                finalBranch == config.masterBranch &&
                git.branchExistsLocal(config.developBranch)
            ) {
                git.checkout(config.developBranch)
                finalBranch = config.developBranch
            }
        } else {
            git.checkout(taskBranch)
            finalBranch = taskBranch
        }

        ui.setPendingConflict(null)
        val targetsLabel = doneTargets.joinToString(" + ")
        val pushSuffix = if (anyPushed) " 및 푸시" else " (로컬 전용)"
        val branchSuffix = if (deleteSourceOnComplete) {
            ", '$taskBranch' 삭제"
        } else {
            ", '$taskBranch' 유지"
        }
        val msg = "'$taskBranch' → '$targetsLabel' 병합${pushSuffix} 완료$branchSuffix"
        ui.showInfo(msg)
        return WorkflowResult(
            status = WorkflowStatus.SUCCESS,
            message = msg,
            branch = finalBranch,
        )
    }

    /**
     * Action 2: Merge current task branch into selected target branch(es) (`develop`, `master`, or both) and optionally delete it.
     */
    fun mergeToDevelop(): WorkflowResult {
        checkInProgressState()?.let { return it }

        val actionLabel = if (config.useDevelopBranch) "작업 반영" else "운영 반영"

        val taskBranch = git.getCurrentBranch()
        if (taskBranch == null) {
            val msg = "Detached HEAD 상태에서는 ${actionLabel}을 진행할 수 없습니다."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        if (BranchNamer.isProtectedBranch(taskBranch, config)) {
            val msg = "보호 브랜치('$taskBranch')에서는 ${actionLabel}을 실행할 수 없습니다. 작업 브랜치로 이동해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        if (git.hasUncommittedChanges()) {
            val msg = "커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        val selectedTargets = if (config.useDevelopBranch) {
            val targetChoice = ui.promptMergeTarget(taskBranch, config.developBranch, config.masterBranch)
            if (targetChoice == MergeTargetChoice.CANCEL) {
                return WorkflowResult(WorkflowStatus.CANCELLED, "${actionLabel}을 취소했습니다.", branch = taskBranch)
            }
            resolveSelectedTargets(targetChoice)
        } else {
            listOf(config.masterBranch)
        }

        val targetCounts = selectedTargets.map { target ->
            syncBranch(target)
            target to git.getAheadCommits(target, taskBranch).size
        }

        val effectiveTargets = targetCounts.filter { it.second > 0 }
        if (effectiveTargets.isEmpty()) {
            val targetSummary = selectedTargets.joinToString(" + ")
            if (ui.confirmDeleteAlreadyMergedBranch(taskBranch, targetSummary)) {
                val landingBranch = if (config.useDevelopBranch && selectedTargets.contains(config.developBranch)) {
                    config.developBranch
                } else {
                    selectedTargets.first()
                }
                if (git.getCurrentBranch() != landingBranch) {
                    git.checkout(landingBranch)
                }
                cleanupTaskBranch(taskBranch, force = false)
                val msg = "'$taskBranch'는 이미 '$targetSummary'에 반영되어 있어 브랜치를 삭제했습니다."
                ui.showInfo(msg)
                return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = landingBranch)
            }

            git.checkout(taskBranch)
            val msg = "${targetSummary}에 병합할 새 커밋이 없습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.NOOP, msg, branch = taskBranch)
        }

        val effectiveBranches = effectiveTargets.map { it.first }
        val maxCommitCount = effectiveTargets.maxOf { it.second }
        val choice = ui.confirmMergeToDevelop(taskBranch, effectiveBranches.joinToString(" + "), maxCommitCount)
        if (choice == MergeToDevelopChoice.CANCEL) {
            git.checkout(taskBranch)
            return WorkflowResult(WorkflowStatus.CANCELLED, "${actionLabel}을 취소했습니다.", branch = taskBranch)
        }

        return executeTaskMergeTargets(
            taskBranch = taskBranch,
            targets = effectiveBranches,
            deleteSourceOnComplete = choice == MergeToDevelopChoice.DELETE,
            alreadySynced = true,
        )
    }

    /**
     * Standalone Action: Delete current non-protected task branch (safe `-d` if merged, warning + `-D` if unmerged).
     */
    fun deleteTaskBranch(): WorkflowResult {
        checkInProgressState()?.let { return it }

        val taskBranch = git.getCurrentBranch()
        if (taskBranch == null) {
            val msg = "Detached HEAD 상태에서는 브랜치 삭제를 진행할 수 없습니다."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        if (BranchNamer.isProtectedBranch(taskBranch, config)) {
            val msg = "보호 브랜치('$taskBranch')는 삭제할 수 없습니다."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        if (git.hasUncommittedChanges()) {
            val msg = "커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        val candidateBases = if (config.useDevelopBranch) {
            listOf(config.developBranch, config.masterBranch)
        } else {
            listOf(config.masterBranch)
        }

        val mergedTarget = candidateBases.firstOrNull { candidate ->
            git.branchExistsLocal(candidate) && git.getAheadCommits(candidate, taskBranch).isEmpty()
        }

        val preferredBase = config.taskBaseBranch()
        val returnBranch = when {
            git.branchExistsLocal(preferredBase) -> preferredBase
            else -> candidateBases.firstOrNull { git.branchExistsLocal(it) }
                ?: if (git.ensureLocalBranch(preferredBase, config.remote)) {
                    preferredBase
                } else {
                    throw IllegalStateException("복귀할 기준 브랜치('$preferredBase')를 찾을 수 없습니다.")
                }
        }

        val unmergedCommitCount = if (mergedTarget != null) {
            0
        } else {
            git.getAheadCommits(returnBranch, taskBranch).size
        }

        if (!ui.confirmDeleteTaskBranch(taskBranch, unmergedCommitCount, returnBranch)) {
            return WorkflowResult(WorkflowStatus.CANCELLED, "브랜치 삭제를 취소했습니다.", branch = taskBranch)
        }

        if (mergedTarget != null) {
            git.checkout(mergedTarget)
            cleanupTaskBranch(taskBranch, force = false)
            if (returnBranch != mergedTarget) {
                git.checkout(returnBranch)
            }
        } else {
            git.checkout(returnBranch)
            cleanupTaskBranch(taskBranch, force = true)
        }

        val msg = "'$taskBranch' 브랜치를 삭제하고 '$returnBranch'로 이동했습니다."
        ui.showInfo(msg)
        return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = returnBranch)
    }

    /**
     * Action 3: Merge verified develop branch into master and push.
     */
    fun releaseToMaster(): WorkflowResult {
        checkInProgressState()?.let { return it }

        if (!config.useDevelopBranch) {
            val msg = "현재 저장소는 develop 브랜치를 사용하지 않는 모드(useDevelopBranch: false)입니다. 작업 브랜치에서 운영 바로 반영을 실행해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        if (git.hasUncommittedChanges()) {
            val msg = "커밋되지 않은 변경사항이 있습니다. 먼저 커밋하거나 Stash한 뒤 다시 시도해 주세요."
            ui.showWarning(msg)
            return WorkflowResult(WorkflowStatus.BLOCKED, msg)
        }

        val originalBranch = git.getCurrentBranch()
        syncBranch(config.developBranch)
        syncBranch(config.masterBranch)

        val aheadCommits = git.getAheadCommits(config.masterBranch, config.developBranch)
        val restoreTarget = if (originalBranch != null && originalBranch != config.masterBranch) {
            originalBranch
        } else {
            config.developBranch
        }

        if (aheadCommits.isEmpty()) {
            restoreBranchIfExists(restoreTarget)
            val msg = "${config.masterBranch}에 반영할 새 커밋이 없습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.NOOP, msg, branch = restoreTarget)
        }

        if (!ui.confirmReleaseToMaster(config.developBranch, config.masterBranch, aheadCommits)) {
            restoreBranchIfExists(restoreTarget)
            return WorkflowResult(WorkflowStatus.CANCELLED, "운영 반영을 취소했습니다.", branch = restoreTarget)
        }

        val mergeResult = git.merge(config.developBranch, config.useNoFastForwardMerge)
        if (mergeResult.conflicted) {
            return handleMergeConflict(
                PendingConflictContext(
                    targetBranch = config.masterBranch,
                    sourceBranch = config.developBranch,
                    returnBranch = originalBranch ?: config.developBranch,
                    deleteSourceOnComplete = false,
                    kind = PendingConflictContext.KIND_RELEASE_TO_MASTER,
                ),
                mergeResult.conflictedFiles,
            )
        }

        val pushed = pushIfRemoteExists(config.masterBranch)
        val finalBranch = if (config.returnToDevelopAfterRelease) {
            git.checkout(config.developBranch)
            config.developBranch
        } else {
            config.masterBranch
        }

        ui.setPendingConflict(null)
        val pushSuffix = if (pushed) " 및 푸시" else " (로컬 전용)"
        val msg = "'${config.developBranch}' → '${config.masterBranch}' 운영 반영${pushSuffix} 완료"
        ui.showInfo(msg)
        return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = finalBranch)
    }

    /**
     * Conflict Action: Open merge tool for currently conflicted files.
     */
    fun openConflictResolver(): WorkflowResult {
        if (!git.isMergeInProgress()) {
            ui.setPendingConflict(null)
            val msg = "진행 중인 머지 충돌이 없습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.NOOP, msg)
        }

        val conflictedFiles = git.getConflictedFiles()
        if (conflictedFiles.isEmpty()) {
            val msg = "남아 있는 충돌 파일이 없습니다. '충돌 해결 완료'를 실행해 주세요."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.SUCCESS, msg)
        }

        ui.openConflictedFiles(conflictedFiles)
        val remaining = if (git.isMergeInProgress()) git.getConflictedFiles() else emptyList()
        return if (remaining.isEmpty()) {
            WorkflowResult(
                status = WorkflowStatus.SUCCESS,
                message = "모든 충돌이 해결되었습니다.",
            )
        } else {
            WorkflowResult(
                status = WorkflowStatus.CONFLICT,
                message = "아직 해결되지 않은 충돌 파일이 ${remaining.size}개 있습니다.",
                conflictedFiles = remaining,
            )
        }
    }

    /**
     * Conflict Action: Complete merge commit and push after user resolves conflicts.
     */
    fun continueAfterConflict(): WorkflowResult {
        if (!git.isMergeInProgress()) {
            ui.setPendingConflict(null)
            val msg = "진행 중인 머지가 없습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.NOOP, msg)
        }

        val conflictedFiles = git.getConflictedFiles()
        if (conflictedFiles.isNotEmpty()) {
            val msg = "아직 해결되지 않은 충돌 파일이 ${conflictedFiles.size}개 있습니다. 모든 충돌을 해결하고 저장(Stage)한 뒤 다시 실행해 주세요."
            ui.showWarning(msg)
            ui.openConflictedFiles(conflictedFiles)
            return WorkflowResult(
                status = WorkflowStatus.CONFLICT,
                message = msg,
                conflictedFiles = conflictedFiles,
            )
        }

        val ctx = ui.getPendingConflict()
        val currentBranch = git.getCurrentBranch()
        val targetBranch = ctx?.targetBranch ?: currentBranch

        git.commitMerge()
        val pushed = targetBranch?.let { pushIfRemoteExists(it) } ?: false

        if (
            (
                ctx?.kind == PendingConflictContext.KIND_MERGE_TO_DEVELOP ||
                    ctx?.kind == PendingConflictContext.KIND_MERGE_TO_MASTER
            ) &&
            ctx.remainingTargets.isNotEmpty()
        ) {
            ui.setPendingConflict(null)
            return executeTaskMergeTargets(
                taskBranch = ctx.sourceBranch,
                targets = ctx.remainingTargets,
                deleteSourceOnComplete = ctx.deleteSourceOnComplete,
                alreadySynced = false,
                completedTargets = listOfNotNull(targetBranch),
                anyPushedSoFar = pushed,
            )
        }

        var finalBranch = targetBranch
        if (
            ctx?.kind == PendingConflictContext.KIND_MERGE_TO_DEVELOP ||
            ctx?.kind == PendingConflictContext.KIND_MERGE_TO_MASTER
        ) {
            if (ctx.deleteSourceOnComplete) {
                cleanupTaskBranch(ctx.sourceBranch, force = false)
                if (
                    ctx.kind == PendingConflictContext.KIND_MERGE_TO_MASTER &&
                    config.useDevelopBranch &&
                    config.returnToDevelopAfterRelease &&
                    git.branchExistsLocal(config.developBranch)
                ) {
                    git.checkout(config.developBranch)
                    finalBranch = config.developBranch
                }
            } else {
                restoreBranchIfExists(ctx.returnBranch)
                finalBranch = ctx.returnBranch
            }
        } else if (ctx?.kind == PendingConflictContext.KIND_RELEASE_TO_MASTER && config.returnToDevelopAfterRelease) {
            git.checkout(config.developBranch)
            finalBranch = config.developBranch
        }

        ui.setPendingConflict(null)
        val pushSuffix = if (pushed) " 및 푸시" else ""
        val msg = "충돌 해결 후 '${targetBranch ?: "현재 브랜치"}' 병합 커밋${pushSuffix}를 완료했습니다."
        ui.showInfo(msg)
        return WorkflowResult(WorkflowStatus.SUCCESS, msg, branch = finalBranch)
    }

    /**
     * Conflict Action: Abort ongoing merge and restore previous branch.
     */
    fun abortMerge(): WorkflowResult {
        if (!git.isMergeInProgress()) {
            ui.setPendingConflict(null)
            val msg = "취소할 머지가 없습니다."
            ui.showInfo(msg)
            return WorkflowResult(WorkflowStatus.NOOP, msg)
        }

        val ctx = ui.getPendingConflict()
        val currentBranch = git.getCurrentBranch()
        val targetLabel = ctx?.targetBranch ?: currentBranch ?: "현재 브랜치"

        if (!ui.confirmAbortMerge(targetLabel)) {
            return WorkflowResult(WorkflowStatus.CANCELLED, "머지 취소를 보류했습니다.")
        }

        return executeAbort(ctx)
    }
}
