package io.github.parkcg123.gitlane.workflow

data class PendingConflictContext(
    val targetBranch: String,
    val sourceBranch: String,
    val returnBranch: String,
    val deleteSourceOnComplete: Boolean,
    val kind: String,
) {
    companion object {
        const val KIND_MERGE_TO_DEVELOP = "mergeToDevelop"
        const val KIND_RELEASE_TO_MASTER = "releaseToMaster"
    }
}
